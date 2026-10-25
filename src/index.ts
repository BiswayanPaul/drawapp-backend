import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { parse } from "url";
import {
  DrawElement,
  MAX_POINTS_PER_STROKE,
  cleanElement,
  cleanPoint,
  cleanPoints,
} from "./elements";
import { loadRoom, saveRoom } from "./storage";
import { TOKEN_SECRET, safeEqual, verifyRoomToken } from "./tokens";

const app = express();
app.use(express.json({ limit: "4kb" }));

const PORT = process.env.PORT || 8080;
// Keep rooms bounded; the oldest elements fall off first.
const MAX_ELEMENTS = 5000;
const MAX_MESSAGE_BYTES = 256 * 1024;
const SAVE_DELAY_MS = 2000;
const EVICT_DELAY_MS = 10 * 60 * 1000;
const ROOM_ID_PATTERN = /^[A-Za-z0-9]{4,12}$/;

type Member = {
  connectionId: string;
  userId: string | null;
  name: string;
  image: string | null;
};

type Room = {
  id: string;
  clients: Set<WebSocket>;
  elements: Map<string, DrawElement>;
  ready: Promise<void>;
  // False when the stored copy couldn't be read; saving then would wipe it.
  persist: boolean;
  // Unknown (null) if the database couldn't be reached.
  accessVersion: number | null;
  saveTimer?: NodeJS.Timeout;
  evictTimer?: NodeJS.Timeout;
};

const rooms: { [roomId: string]: Room } = {};
const alive = new WeakMap<WebSocket, boolean>();
const members = new WeakMap<WebSocket, Member>();
const tokenVersions = new WeakMap<WebSocket, number>();
const ACCESS_REVOKED = 4003;

app.get(["/", "/health"], (_req, res) => {
  res.json({ status: "ok", rooms: Object.keys(rooms).length });
});

// Called by the Next.js app when a room's password changes: everyone holding an
// older token is disconnected and has to get a new one (re-entering the password).
app.post("/internal/rooms/:roomId/revoke", (req, res) => {
  const auth = req.header("authorization") ?? "";
  if (!TOKEN_SECRET || !safeEqual(auth, `Bearer ${TOKEN_SECRET}`)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const room = rooms[req.params.roomId.toUpperCase()];
  const accessVersion = Number(req.body?.accessVersion);
  if (room && Number.isInteger(accessVersion)) {
    room.accessVersion = accessVersion;
    room.clients.forEach((client) => {
      if (tokenVersions.get(client) !== accessVersion) {
        client.close(ACCESS_REVOKED, "Room access changed");
      }
    });
  }
  res.json({ ok: true });
});

const httpServer = app.listen(PORT, () => {
  console.log(`HTTP + WebSocket server listening on port ${PORT}`);
});

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: MAX_MESSAGE_BYTES,
});

function getRoom(roomId: string) {
  if (!rooms[roomId]) {
    const room: Room = {
      id: roomId,
      clients: new Set(),
      elements: new Map(),
      ready: Promise.resolve(),
      persist: true,
      accessVersion: null,
    };
    room.ready = loadRoom(roomId).then((stored) => {
      room.persist = stored !== null;
      room.accessVersion = stored?.accessVersion ?? null;
      stored?.elements.forEach((el) => room.elements.set(el.id, el));
    });
    rooms[roomId] = room;
  }
  return rooms[roomId];
}

function scheduleSave(room: Room) {
  if (!room.persist) return;
  clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => {
    saveRoom(room.id, Array.from(room.elements.values()));
  }, SAVE_DELAY_MS);
}

function flushSave(room: Room) {
  if (!room.saveTimer) return;
  clearTimeout(room.saveTimer);
  room.saveTimer = undefined;
  return saveRoom(room.id, Array.from(room.elements.values()));
}

function addElement(room: Room, element: DrawElement) {
  room.elements.delete(element.id);
  room.elements.set(element.id, element);
  if (room.elements.size > MAX_ELEMENTS) {
    const oldest = room.elements.keys().next().value;
    if (oldest) room.elements.delete(oldest);
  }
}

function broadcast(room: Room, message: unknown, senderWs?: WebSocket) {
  const data = JSON.stringify(message);
  room.clients.forEach((client) => {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

function broadcastPresence(room: Room) {
  const users = Array.from(room.clients, (client) => members.get(client)).filter(
    (member): member is Member => !!member
  );
  broadcast(room, { type: "presence", count: room.clients.size, users });
}

function cleanString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : null;
}

function handleMessage(ws: WebSocket, room: Room, data: Record<string, any>) {
  const member = members.get(ws);

  switch (data.type) {
    case "join": {
      // Only used without room tokens; with them, identity comes from the signed token.
      if (!member || TOKEN_SECRET) return;
      const image = cleanString(data.user?.image, 500);
      member.userId = cleanString(data.user?.id, 64);
      member.name = cleanString(data.user?.name, 60) ?? "Guest";
      member.image = image?.startsWith("https://") ? image : null;
      broadcastPresence(room);
      return;
    }
    case "add": {
      const element = cleanElement(data.element);
      if (!element) return;
      addElement(room, element);
      broadcast(room, { type: "add", element }, ws);
      scheduleSave(room);
      return;
    }
    case "append": {
      const stroke = room.elements.get(data.id);
      const points = cleanPoints(data.points, 500);
      if (stroke?.kind !== "stroke" || !points) return;
      if (stroke.points.length + points.length > MAX_POINTS_PER_STROKE) return;
      stroke.points.push(...points);
      broadcast(room, { type: "append", id: stroke.id, points }, ws);
      scheduleSave(room);
      return;
    }
    case "remove": {
      if (typeof data.id !== "string" || !room.elements.delete(data.id)) return;
      broadcast(room, { type: "remove", id: data.id }, ws);
      scheduleSave(room);
      return;
    }
    case "clear": {
      room.elements.clear();
      broadcast(room, { type: "clear" }, ws);
      scheduleSave(room);
      return;
    }
    case "cursor": {
      if (!member) return;
      const point = cleanPoint(data);
      if (!point) return;
      broadcast(
        room,
        { type: "cursor", connectionId: member.connectionId, ...point },
        ws
      );
      return;
    }
  }
}

wss.on("connection", async function connection(ws, req) {
  const { query } = parse(req.url || "", true);
  const roomId = String(query.roomId || "").toUpperCase();

  if (!ROOM_ID_PATTERN.test(roomId)) {
    ws.send(JSON.stringify({ type: "error", error: "Invalid room ID." }));
    ws.close();
    return;
  }

  const token = TOKEN_SECRET ? verifyRoomToken(String(query.token || "")) : null;
  if (TOKEN_SECRET && token?.roomId !== roomId) {
    ws.close(ACCESS_REVOKED, "Invalid room token");
    return;
  }

  const room = getRoom(roomId);
  clearTimeout(room.evictTimer);
  room.clients.add(ws);
  alive.set(ws, true);
  const member: Member = {
    connectionId: Math.random().toString(36).slice(2, 10),
    userId: token?.userId ?? null,
    name: token?.name ?? "Guest",
    image: token?.image ?? null,
  };
  members.set(ws, member);
  if (token) tokenVersions.set(ws, token.accessVersion);
  ws.on("pong", () => alive.set(ws, true));

  // Messages can arrive while the room is still loading from the database.
  const ready = room.ready;

  ws.on("message", async function message(raw) {
    await ready;
    if (ws.readyState !== WebSocket.OPEN) return; // rejected while the room was loading
    try {
      handleMessage(ws, room, JSON.parse(raw.toString()));
    } catch (error) {
      console.error("Error handling message", error);
    }
  });

  ws.on("close", () => {
    room.clients.delete(ws);
    broadcastPresence(room);
    if (room.clients.size > 0) return;
    flushSave(room);
    // Keep the room warm briefly so a refresh doesn't hit the database again.
    room.evictTimer = setTimeout(() => {
      if (room.clients.size === 0 && rooms[roomId] === room) delete rooms[roomId];
    }, EVICT_DELAY_MS);
  });

  await ready;
  if (ws.readyState !== WebSocket.OPEN) return;
  if (token && room.accessVersion !== null && token.accessVersion !== room.accessVersion) {
    ws.close(ACCESS_REVOKED, "Room access changed");
    return;
  }
  ws.send(
    JSON.stringify({
      type: "init",
      connectionId: member.connectionId,
      elements: Array.from(room.elements.values()),
    })
  );
  broadcastPresence(room);
});

// Drop connections that vanished without a close frame (closed laptop, lost network).
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!alive.get(ws)) return ws.terminate();
    alive.set(ws, false);
    ws.ping();
  });
}, 30000);

// Render sends SIGTERM on redeploys; persist anything pending first.
process.on("SIGTERM", async () => {
  clearInterval(heartbeat);
  await Promise.all(Object.values(rooms).map(flushSave));
  process.exit(0);
});
