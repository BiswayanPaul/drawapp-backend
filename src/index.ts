import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { parse } from "url";

const app = express();

const PORT = process.env.PORT || 8080;

const httpServer = app.listen(PORT, () => {
  console.log("HTTP server listening on port 8080");
});

const wss = new WebSocketServer({ server: httpServer });

const rooms: { [roomId: string]: Set<WebSocket> } = {};

function joinRoom(ws: WebSocket, roomId: string) {
  if (!rooms[roomId]) {
    rooms[roomId] = new Set();
  }
  rooms[roomId].add(ws);
}

function broadcastToRoom(roomId: string, message: string, senderWs: WebSocket) {
  if (rooms[roomId]) {
    rooms[roomId].forEach((client) => {
      if (client !== senderWs && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }
}

wss.on("connection", function connection(ws, req) {
  const { query } = parse(req.url || "", true);
  const roomId = query.roomId as string;

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
      } else if (parsedData.type === "clear") {
        broadcastToRoom(roomId, JSON.stringify({ type: "clear" }), ws);
      }
    } catch (error) {
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

  ws.send(
    JSON.stringify({ type: "info", message: `Connected to room: ${roomId}` })
  );
});

console.log(`WebSocket server is running on ws://localhost:${PORT}`);
