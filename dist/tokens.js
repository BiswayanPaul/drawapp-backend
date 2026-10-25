"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOKEN_SECRET = void 0;
exports.safeEqual = safeEqual;
exports.verifyRoomToken = verifyRoomToken;
const crypto_1 = require("crypto");
// Room tokens are minted by the Next.js app after it checks the user may enter the room
// (signed in, and knows the password for private rooms). Both sides share ROOM_TOKEN_SECRET.
exports.TOKEN_SECRET = process.env.ROOM_TOKEN_SECRET || "";
if (!exports.TOKEN_SECRET) {
    console.warn("ROOM_TOKEN_SECRET not set; rooms are open to anyone with the code.");
}
const sign = (payload) => (0, crypto_1.createHmac)("sha256", exports.TOKEN_SECRET).update(payload).digest("base64url");
function safeEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && (0, crypto_1.timingSafeEqual)(left, right);
}
function verifyRoomToken(token) {
    const [payload, signature] = token.split(".");
    if (!payload || !signature || !safeEqual(sign(payload), signature))
        return null;
    try {
        const data = JSON.parse(Buffer.from(payload, "base64url").toString());
        if (typeof data.exp !== "number" || data.exp < Date.now())
            return null;
        return {
            roomId: String(data.r),
            userId: String(data.u),
            name: String(data.n || "Guest").slice(0, 60),
            image: typeof data.i === "string" && data.i.startsWith("https://") ? data.i : null,
            accessVersion: Number(data.v) || 0,
        };
    }
    catch (_a) {
        return null;
    }
}
