import { createHmac, timingSafeEqual } from "crypto";

// Room tokens are minted by the Next.js app after it checks the user may enter the room
// (signed in, and knows the password for private rooms). Both sides share ROOM_TOKEN_SECRET.
export const TOKEN_SECRET = process.env.ROOM_TOKEN_SECRET || "";

if (!TOKEN_SECRET) {
  console.warn("ROOM_TOKEN_SECRET not set; rooms are open to anyone with the code.");
}

export type RoomToken = {
  roomId: string;
  userId: string;
  name: string;
  image: string | null;
  accessVersion: number;
};

const sign = (payload: string) =>
  createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyRoomToken(token: string): RoomToken | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(sign(payload), signature)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return {
      roomId: String(data.r),
      userId: String(data.u),
      name: String(data.n || "Guest").slice(0, 60),
      image: typeof data.i === "string" && data.i.startsWith("https://") ? data.i : null,
      accessVersion: Number(data.v) || 0,
    };
  } catch {
    return null;
  }
}
