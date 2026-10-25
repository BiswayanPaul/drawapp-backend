"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const ws_1 = require("ws");
const url_1 = require("url");
const elements_1 = require("./elements");
const storage_1 = require("./storage");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 8080;
// Keep rooms bounded; the oldest elements fall off first.
const MAX_ELEMENTS = 5000;
const MAX_MESSAGE_BYTES = 256 * 1024;
const SAVE_DELAY_MS = 2000;
const EVICT_DELAY_MS = 10 * 60 * 1000;
const ROOM_ID_PATTERN = /^[A-Za-z0-9]{4,12}$/;
const rooms = {};
const alive = new WeakMap();
const members = new WeakMap();
app.get(["/", "/health"], (_req, res) => {
    res.json({ status: "ok", rooms: Object.keys(rooms).length });
});
const httpServer = app.listen(PORT, () => {
    console.log(`HTTP + WebSocket server listening on port ${PORT}`);
});
const wss = new ws_1.WebSocketServer({
    server: httpServer,
    maxPayload: MAX_MESSAGE_BYTES,
});
function getRoom(roomId) {
    if (!rooms[roomId]) {
        const room = {
            id: roomId,
            clients: new Set(),
            elements: new Map(),
            ready: Promise.resolve(),
        };
        room.ready = (0, storage_1.loadRoom)(roomId).then((elements) => {
            elements.forEach((el) => room.elements.set(el.id, el));
        });
        rooms[roomId] = room;
    }
    return rooms[roomId];
}
function scheduleSave(room) {
    clearTimeout(room.saveTimer);
    room.saveTimer = setTimeout(() => {
        (0, storage_1.saveRoom)(room.id, Array.from(room.elements.values()));
    }, SAVE_DELAY_MS);
}
function flushSave(room) {
    if (!room.saveTimer)
        return;
    clearTimeout(room.saveTimer);
    room.saveTimer = undefined;
    return (0, storage_1.saveRoom)(room.id, Array.from(room.elements.values()));
}
function addElement(room, element) {
    room.elements.delete(element.id);
    room.elements.set(element.id, element);
    if (room.elements.size > MAX_ELEMENTS) {
        const oldest = room.elements.keys().next().value;
        if (oldest)
            room.elements.delete(oldest);
    }
}
function broadcast(room, message, senderWs) {
    const data = JSON.stringify(message);
    room.clients.forEach((client) => {
        if (client !== senderWs && client.readyState === ws_1.WebSocket.OPEN) {
            client.send(data);
        }
    });
}
function broadcastPresence(room) {
    const users = Array.from(room.clients, (client) => members.get(client)).filter((member) => !!member);
    broadcast(room, { type: "presence", count: room.clients.size, users });
}
function cleanString(value, maxLength) {
    return typeof value === "string" && value.trim()
        ? value.trim().slice(0, maxLength)
        : null;
}
function handleMessage(ws, room, data) {
    var _a, _b, _c, _d;
    const member = members.get(ws);
    switch (data.type) {
        case "join": {
            // Identity is self-reported by the client; good enough for showing who's here.
            if (!member)
                return;
            const image = cleanString((_a = data.user) === null || _a === void 0 ? void 0 : _a.image, 500);
            member.userId = cleanString((_b = data.user) === null || _b === void 0 ? void 0 : _b.id, 64);
            member.name = (_d = cleanString((_c = data.user) === null || _c === void 0 ? void 0 : _c.name, 60)) !== null && _d !== void 0 ? _d : "Guest";
            member.image = (image === null || image === void 0 ? void 0 : image.startsWith("https://")) ? image : null;
            broadcastPresence(room);
            return;
        }
        case "add": {
            const element = (0, elements_1.cleanElement)(data.element);
            if (!element)
                return;
            addElement(room, element);
            broadcast(room, { type: "add", element }, ws);
            scheduleSave(room);
            return;
        }
        case "append": {
            const stroke = room.elements.get(data.id);
            const points = (0, elements_1.cleanPoints)(data.points, 500);
            if ((stroke === null || stroke === void 0 ? void 0 : stroke.kind) !== "stroke" || !points)
                return;
            if (stroke.points.length + points.length > elements_1.MAX_POINTS_PER_STROKE)
                return;
            stroke.points.push(...points);
            broadcast(room, { type: "append", id: stroke.id, points }, ws);
            scheduleSave(room);
            return;
        }
        case "remove": {
            if (typeof data.id !== "string" || !room.elements.delete(data.id))
                return;
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
            if (!member)
                return;
            const point = (0, elements_1.cleanPoint)(data);
            if (!point)
                return;
            broadcast(room, Object.assign({ type: "cursor", connectionId: member.connectionId }, point), ws);
            return;
        }
    }
}
wss.on("connection", function connection(ws, req) {
    return __awaiter(this, void 0, void 0, function* () {
        const { query } = (0, url_1.parse)(req.url || "", true);
        const roomId = String(query.roomId || "").toUpperCase();
        if (!ROOM_ID_PATTERN.test(roomId)) {
            ws.send(JSON.stringify({ type: "error", error: "Invalid room ID." }));
            ws.close();
            return;
        }
        const room = getRoom(roomId);
        clearTimeout(room.evictTimer);
        room.clients.add(ws);
        alive.set(ws, true);
        const member = {
            connectionId: Math.random().toString(36).slice(2, 10),
            userId: null,
            name: "Guest",
            image: null,
        };
        members.set(ws, member);
        ws.on("pong", () => alive.set(ws, true));
        // Messages can arrive while the room is still loading from the database.
        const ready = room.ready;
        ws.on("message", function message(raw) {
            return __awaiter(this, void 0, void 0, function* () {
                yield ready;
                try {
                    handleMessage(ws, room, JSON.parse(raw.toString()));
                }
                catch (error) {
                    console.error("Error handling message", error);
                }
            });
        });
        ws.on("close", () => {
            room.clients.delete(ws);
            broadcastPresence(room);
            if (room.clients.size > 0)
                return;
            flushSave(room);
            // Keep the room warm briefly so a refresh doesn't hit the database again.
            room.evictTimer = setTimeout(() => {
                if (room.clients.size === 0 && rooms[roomId] === room)
                    delete rooms[roomId];
            }, EVICT_DELAY_MS);
        });
        yield ready;
        if (ws.readyState !== ws_1.WebSocket.OPEN)
            return;
        ws.send(JSON.stringify({
            type: "init",
            connectionId: member.connectionId,
            elements: Array.from(room.elements.values()),
        }));
        broadcastPresence(room);
    });
});
// Drop connections that vanished without a close frame (closed laptop, lost network).
const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!alive.get(ws))
            return ws.terminate();
        alive.set(ws, false);
        ws.ping();
    });
}, 30000);
// Render sends SIGTERM on redeploys; persist anything pending first.
process.on("SIGTERM", () => __awaiter(void 0, void 0, void 0, function* () {
    clearInterval(heartbeat);
    yield Promise.all(Object.values(rooms).map(flushSave));
    process.exit(0);
}));
