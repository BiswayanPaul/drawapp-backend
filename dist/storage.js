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
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadRoom = loadRoom;
exports.saveRoom = saveRoom;
const pg_1 = require("pg");
// Persistence is optional: without DATABASE_URL rooms simply live in memory.
function createPool() {
    if (!process.env.DATABASE_URL) {
        console.warn("DATABASE_URL not set; drawings will not survive restarts.");
        return null;
    }
    const url = new URL(process.env.DATABASE_URL);
    const sslmode = url.searchParams.get("sslmode");
    // node-postgres treats sslmode=require as full verification, which rejects
    // managed providers' self-signed CAs (Aiven). Encrypt without verifying instead.
    url.searchParams.delete("sslmode");
    return new pg_1.Pool({
        connectionString: url.toString(),
        ssl: sslmode && sslmode !== "disable" ? { rejectUnauthorized: false } : undefined,
        max: 3,
    });
}
const pool = createPool();
function loadRoom(roomId) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        if (!pool)
            return [];
        try {
            const { rows } = yield pool.query('SELECT elements FROM "Room" WHERE id = $1', [roomId]);
            return Array.isArray((_a = rows[0]) === null || _a === void 0 ? void 0 : _a.elements) ? rows[0].elements : [];
        }
        catch (error) {
            console.error(`Failed to load room ${roomId}`, error);
            return [];
        }
    });
}
function saveRoom(roomId, elements) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!pool)
            return;
        try {
            yield pool.query(`INSERT INTO "Room" (id, elements, "createdAt", "updatedAt")
       VALUES ($1, $2, now(), now())
       ON CONFLICT (id) DO UPDATE SET elements = $2, "updatedAt" = now()`, [roomId, JSON.stringify(elements)]);
        }
        catch (error) {
            console.error(`Failed to save room ${roomId}`, error);
        }
    });
}
