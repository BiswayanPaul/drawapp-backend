"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const ws_1 = require("ws");
const url_1 = require("url");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 8080;
// Keep enough strokes for a late joiner to see the drawing, without unbounded memory.
const MAX_HISTORY = 20000;
const MAX_MESSAGE_BYTES = 4 * 1024;
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
function joinRoom(ws, roomId) {
    if (!rooms[roomId]) {
        rooms[roomId] = { clients: new Set(), history: [] };
    }
    rooms[roomId].clients.add(ws);
    return rooms[roomId];
}
function broadcastToRoom(roomId, message, senderWs) {
    var _a;
    (_a = rooms[roomId]) === null || _a === void 0 ? void 0 : _a.clients.forEach((client) => {
        if (client !== senderWs && client.readyState === ws_1.WebSocket.OPEN) {
            client.send(message);
        }
    });
}
function broadcastPresence(roomId) {
    const room = rooms[roomId];
    if (!room)
        return;
    const users = Array.from(room.clients, (client) => members.get(client)).filter((member) => !!member);
    broadcastToRoom(roomId, JSON.stringify({ type: "presence", count: room.clients.size, users }));
}
function cleanString(value, maxLength) {
    return typeof value === "string" && value.trim()
        ? value.trim().slice(0, maxLength)
        : null;
}
function isValidSegment(value) {
    var _a, _b, _c, _d;
    const s = value;
    return (!!s &&
        typeof s.color === "string" &&
        s.color.length <= 32 &&
        typeof s.size === "number" &&
        s.size > 0 &&
        s.size <= 200 &&
        [(_a = s.from) === null || _a === void 0 ? void 0 : _a.x, (_b = s.from) === null || _b === void 0 ? void 0 : _b.y, (_c = s.to) === null || _c === void 0 ? void 0 : _c.x, (_d = s.to) === null || _d === void 0 ? void 0 : _d.y].every(Number.isFinite));
}
wss.on("connection", function connection(ws, req) {
    const { query } = (0, url_1.parse)(req.url || "", true);
    const roomId = String(query.roomId || "").toUpperCase();
    if (!ROOM_ID_PATTERN.test(roomId)) {
        ws.send(JSON.stringify({ type: "error", error: "Invalid room ID." }));
        ws.close();
        return;
    }
    const room = joinRoom(ws, roomId);
    alive.set(ws, true);
    members.set(ws, {
        connectionId: Math.random().toString(36).slice(2, 10),
        userId: null,
        name: "Guest",
        image: null,
    });
    ws.on("pong", () => alive.set(ws, true));
    ws.send(JSON.stringify({ type: "history", segments: room.history }));
    broadcastPresence(roomId);
    ws.on("message", function message(data) {
        var _a, _b, _c, _d;
        try {
            const parsedData = JSON.parse(data.toString());
            if (parsedData.type === "draw" && isValidSegment(parsedData.segment)) {
                const { from, to, color, size } = parsedData.segment;
                const segment = { from, to, color, size };
                room.history.push(segment);
                if (room.history.length > MAX_HISTORY)
                    room.history.shift();
                broadcastToRoom(roomId, JSON.stringify({ type: "draw", segment }), ws);
            }
            else if (parsedData.type === "join") {
                // Identity is self-reported by the client; good enough for showing who's here.
                const member = members.get(ws);
                if (member) {
                    const image = cleanString((_a = parsedData.user) === null || _a === void 0 ? void 0 : _a.image, 500);
                    member.userId = cleanString((_b = parsedData.user) === null || _b === void 0 ? void 0 : _b.id, 64);
                    member.name = (_d = cleanString((_c = parsedData.user) === null || _c === void 0 ? void 0 : _c.name, 60)) !== null && _d !== void 0 ? _d : "Guest";
                    member.image = (image === null || image === void 0 ? void 0 : image.startsWith("https://")) ? image : null;
                    broadcastPresence(roomId);
                }
            }
            else if (parsedData.type === "clear") {
                room.history = [];
                broadcastToRoom(roomId, JSON.stringify({ type: "clear" }), ws);
            }
        }
        catch (error) {
            console.error("Error parsing message", error);
        }
    });
    ws.on("close", () => {
        room.clients.delete(ws);
        if (room.clients.size === 0) {
            // Keep the drawing briefly so a refresh doesn't wipe it.
            setTimeout(() => {
                var _a;
                if (((_a = rooms[roomId]) === null || _a === void 0 ? void 0 : _a.clients.size) === 0)
                    delete rooms[roomId];
            }, 10 * 60 * 1000);
        }
        else {
            broadcastPresence(roomId);
        }
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
wss.on("close", () => clearInterval(heartbeat));
