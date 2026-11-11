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
exports.normalizeRoomId = normalizeRoomId;
exports.createRoomToken = createRoomToken;
exports.roomAccess = roomAccess;
exports.createRoom = createRoom;
exports.unlockRoom = unlockRoom;
exports.updateRoomPassword = updateRoomPassword;
exports.onRoomAccessChanged = onRoomAccessChanged;
exports.recentRooms = recentRooms;
const crypto_1 = require("crypto");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const database_1 = require("./database");
const ROOM_ID_PATTERN = /^[A-Z0-9]{4,12}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
function normalizeRoomId(value) {
    const roomId = typeof value === "string" ? value.trim().toUpperCase() : "";
    return ROOM_ID_PATTERN.test(roomId) ? roomId : null;
}
function generateRoomId(length = 6) {
    const bytes = (0, crypto_1.randomBytes)(length);
    return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
}
function roomSecret() {
    return process.env.ROOM_TOKEN_SECRET || "";
}
function createRoomToken(input) {
    var _a;
    const secret = roomSecret();
    if (!secret)
        return null;
    const payload = Buffer.from(JSON.stringify({
        r: input.roomId,
        u: input.user.id,
        n: (_a = input.user.name) !== null && _a !== void 0 ? _a : input.user.email,
        i: input.user.image,
        v: input.accessVersion,
        exp: Date.now() + TOKEN_TTL_MS,
    })).toString("base64url");
    const signature = (0, crypto_1.createHmac)("sha256", secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
}
function password(value) {
    return typeof value === "string" && value.length >= 4 && value.length <= 64 ? value : null;
}
function findOrClaimRoom(roomId, userId) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const { rows } = yield (0, database_1.query)(`INSERT INTO "Room" (id, "ownerId", "createdAt", "updatedAt")
     VALUES ($1, $2, now(), now())
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING id, "ownerId", "passwordHash", "accessVersion"`, [roomId, userId]);
        let room = rows[0];
        // Rooms from before ownership existed are claimed by their next visitor.
        if (!room.ownerId && !room.passwordHash) {
            const claimed = yield (0, database_1.query)(`UPDATE "Room" SET "ownerId" = $2, "updatedAt" = now()
       WHERE id = $1 AND "ownerId" IS NULL AND "passwordHash" IS NULL
       RETURNING id, "ownerId", "passwordHash", "accessVersion"`, [roomId, userId]);
            room = (_a = claimed.rows[0]) !== null && _a !== void 0 ? _a : room;
        }
        return room;
    });
}
function roomAccess(roomId, user) {
    return __awaiter(this, void 0, void 0, function* () {
        const room = yield findOrClaimRoom(roomId, user.id);
        const isOwner = room.ownerId === user.id;
        const isPrivate = room.passwordHash !== null;
        let hasAccess = !isPrivate || isOwner;
        if (!hasAccess) {
            const { rowCount } = yield (0, database_1.query)('SELECT 1 FROM "RoomVisit" WHERE "userId" = $1 AND "roomId" = $2', [user.id, roomId]);
            hasAccess = (rowCount !== null && rowCount !== void 0 ? rowCount : 0) > 0;
        }
        if (hasAccess)
            yield recordVisit(user.id, roomId);
        return {
            roomId,
            isOwner,
            isPrivate,
            hasAccess,
            accessVersion: room.accessVersion,
            token: hasAccess ? createRoomToken({ roomId, user, accessVersion: room.accessVersion }) : null,
        };
    });
}
function createRoom(user, input) {
    return __awaiter(this, void 0, void 0, function* () {
        const suppliedPassword = input === null || input === void 0 ? void 0 : input.password;
        if (suppliedPassword !== undefined && !password(suppliedPassword)) {
            return { error: "Use a room password between 4 and 64 characters." };
        }
        const passwordHash = suppliedPassword === undefined ? null : yield bcryptjs_1.default.hash(suppliedPassword, 10);
        for (let attempt = 0; attempt < 5; attempt++) {
            const roomId = generateRoomId();
            try {
                yield (0, database_1.query)(`INSERT INTO "Room" (id, "ownerId", "passwordHash", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, now(), now())`, [roomId, user.id, passwordHash]);
                yield recordVisit(user.id, roomId);
                return { roomId };
            }
            catch (error) {
                if (error.code !== "23505")
                    throw error;
            }
        }
        return { error: "Couldn't create the room. Please try again." };
    });
}
function unlockRoom(roomId, user, input) {
    return __awaiter(this, void 0, void 0, function* () {
        const suppliedPassword = input === null || input === void 0 ? void 0 : input.password;
        if (typeof suppliedPassword !== "string")
            return { error: "Enter the room password." };
        const { rows } = yield (0, database_1.query)('SELECT "passwordHash" FROM "Room" WHERE id = $1', [roomId]);
        const room = rows[0];
        if (!room)
            return { error: "Room not found." };
        if (room.passwordHash && !(yield bcryptjs_1.default.compare(suppliedPassword, room.passwordHash))) {
            return { error: "Wrong password." };
        }
        yield recordVisit(user.id, roomId);
        return { roomId };
    });
}
function updateRoomPassword(roomId, user, input) {
    return __awaiter(this, void 0, void 0, function* () {
        const suppliedPassword = input === null || input === void 0 ? void 0 : input.password;
        const newPassword = password(suppliedPassword);
        if (suppliedPassword !== null && !newPassword) {
            return { error: "Use a room password between 4 and 64 characters." };
        }
        const { rows } = yield (0, database_1.query)('SELECT "ownerId" FROM "Room" WHERE id = $1', [roomId]);
        if (!rows[0] || rows[0].ownerId !== user.id)
            return { error: "Only the room owner can change this." };
        const passwordHash = suppliedPassword === null ? null : yield bcryptjs_1.default.hash(newPassword, 10);
        const { rows: updated } = yield (0, database_1.query)(`UPDATE "Room"
     SET "passwordHash" = $2, "accessVersion" = "accessVersion" + 1, "updatedAt" = now()
     WHERE id = $1
     RETURNING "accessVersion"`, [roomId, passwordHash]);
        yield (0, database_1.query)('DELETE FROM "RoomVisit" WHERE "roomId" = $1 AND "userId" <> $2', [roomId, user.id]);
        revokeRoomAccess(roomId, updated[0].accessVersion);
        return { roomId };
    });
}
function recordVisit(userId, roomId) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            yield (0, database_1.query)(`INSERT INTO "RoomVisit" ("userId", "roomId", "visitedAt") VALUES ($1, $2, now())
       ON CONFLICT ("userId", "roomId") DO UPDATE SET "visitedAt" = now()`, [userId, roomId]);
        }
        catch (error) {
            console.error("[rooms] Failed to record recent room", error);
        }
    });
}
// The realtime server registers this to disconnect sockets holding older tokens.
let revokeRoomAccess = (_roomId, _accessVersion) => { };
function onRoomAccessChanged(handler) {
    revokeRoomAccess = handler;
}
function recentRooms(userId_1) {
    return __awaiter(this, arguments, void 0, function* (userId, take = 6) {
        const { rows } = yield (0, database_1.query)(`SELECT rv."roomId" AS id, rv."visitedAt" AS "visitedAt",
            r."passwordHash" IS NOT NULL AS "isPrivate", r.elements
     FROM "RoomVisit" rv
     JOIN "Room" r ON r.id = rv."roomId"
     WHERE rv."userId" = $1
     ORDER BY rv."visitedAt" DESC
     LIMIT $2`, [userId, take]);
        return rows;
    });
}
