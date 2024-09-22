"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const ws_1 = require("ws");
const url_1 = require("url");
const app = (0, express_1.default)();
const httpServer = app.listen(8080, () => {
    console.log("HTTP server listening on port 8080");
});
const wss = new ws_1.WebSocketServer({ server: httpServer });
const rooms = {};
function joinRoom(ws, roomId) {
    if (!rooms[roomId]) {
        rooms[roomId] = new Set();
    }
    rooms[roomId].add(ws);
}
function broadcastToRoom(roomId, message, senderWs) {
    if (rooms[roomId]) {
        rooms[roomId].forEach((client) => {
            if (client !== senderWs && client.readyState === ws_1.WebSocket.OPEN) {
                client.send(message);
            }
        });
    }
}
wss.on("connection", function connection(ws, req) {
    const { query } = (0, url_1.parse)(req.url || "", true);
    const roomId = query.roomId;
    if (!roomId) {
        ws.send(JSON.stringify({ error: "No room ID provided." }));
        ws.close();
        return;
    }
    joinRoom(ws, roomId);
    ws.on("message", function message(data) {
        try {
            const parsedData = JSON.parse(data.toString());
            if (parsedData.type === "draw") {
                broadcastToRoom(roomId, data.toString(), ws);
            }
            else if (parsedData.type === "clear") {
                broadcastToRoom(roomId, JSON.stringify({ type: "clear" }), ws);
            }
        }
        catch (error) {
            console.error("Error parsing message", error);
        }
    });
    ws.on("close", () => {
        if (rooms[roomId]) {
            rooms[roomId].delete(ws);
            if (rooms[roomId].size === 0) {
                delete rooms[roomId];
            }
        }
    });
    ws.send(JSON.stringify({ type: "info", message: `Connected to room: ${roomId}` }));
});
console.log("WebSocket server is running on ws://localhost:8080");
