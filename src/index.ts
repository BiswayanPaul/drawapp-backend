import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { parse } from "url";

const app = express();

const PORT = process.env.PORT || 8080;
// Keep enough strokes for a late joiner to see the drawing, without unbounded memory.
const MAX_HISTORY = 20000;
const MAX_MESSAGE_BYTES = 4 * 1024;
const ROOM_ID_PATTERN = /^[A-Za-z0-9]{4,12}$/;

type Segment = {
  from: { x: number; y: number };
  to: { x: number; y: number };
  color: string;
  size: number;
};

type Room = { clients: Set<WebSocket>; history: Segment[] };

const rooms: { [roomId: string]: Room } = {};
const alive = new WeakMap<WebSocket, boolean>();

app.get(["/", "/health"], (_req, res) => {
  res.json({ status: "ok", rooms: Object.keys(rooms).length });
});

const httpServer = app.listen(PORT, () => {
  console.log(`HTTP + WebSocket server listening on port ${PORT}`);
});

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: MAX_MESSAGE_BYTES,
});

function joinRoom(ws: WebSocket, roomId: string) {
  if (!rooms[roomId]) {
    rooms[roomId] = { clients: new Set(), history: [] };
  }
  rooms[roomId].clients.add(ws);
  return rooms[roomId];
}

function broadcastToRoom(roomId: string, message: string, senderWs?: WebSocket) {
  rooms[roomId]?.clients.forEach((client) => {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function broadcastPresence(roomId: string) {
  const room = rooms[roomId];
  if (!room) return;
  broadcastToRoom(
    roomId,
    JSON.stringify({ type: "presence", count: room.clients.size })
  );
}

function isValidSegment(value: unknown): value is Segment {
  const s = value as Segment;
  return (
    !!s &&
    typeof s.color === "string" &&
    s.color.length <= 32 &&
    typeof s.size === "number" &&
    s.size > 0 &&
    s.size <= 200 &&
    [s.from?.x, s.from?.y, s.to?.x, s.to?.y].every(Number.isFinite)
  );
}

wss.on("connection", function connection(ws, req) {
  const { query } = parse(req.url || "", true);
  const roomId = String(query.roomId || "").toUpperCase();

  if (!ROOM_ID_PATTERN.test(roomId)) {
    ws.send(JSON.stringify({ type: "error", error: "Invalid room ID." }));
    ws.close();
    return;
  }

  const room = joinRoom(ws, roomId);
  alive.set(ws, true);
  ws.on("pong", () => alive.set(ws, true));

  ws.send(JSON.stringify({ type: "history", segments: room.history }));
  broadcastPresence(roomId);

  ws.on("message", function message(data) {
    try {
      const parsedData = JSON.parse(data.toString());
      if (parsedData.type === "draw" && isValidSegment(parsedData.segment)) {
        const { from, to, color, size } = parsedData.segment;
        const segment = { from, to, color, size };
        room.history.push(segment);
        if (room.history.length > MAX_HISTORY) room.history.shift();
        broadcastToRoom(roomId, JSON.stringify({ type: "draw", segment }), ws);
      } else if (parsedData.type === "clear") {
        room.history = [];
        broadcastToRoom(roomId, JSON.stringify({ type: "clear" }), ws);
      }
    } catch (error) {
      console.error("Error parsing message", error);
    }
  });

  ws.on("close", () => {
    room.clients.delete(ws);
    if (room.clients.size === 0) {
      // Keep the drawing briefly so a refresh doesn't wipe it.
      setTimeout(() => {
        if (rooms[roomId]?.clients.size === 0) delete rooms[roomId];
      }, 10 * 60 * 1000);
    } else {
      broadcastPresence(roomId);
    }
  });
});

// Drop connections that vanished without a close frame (closed laptop, lost network).
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!alive.get(ws)) return ws.terminate();
    alive.set(ws, false);
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(heartbeat));
