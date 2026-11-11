import { createHmac, randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import type { ApiUser } from "./auth";
import { query } from "./database";
import type { DrawElement } from "./elements";

const ROOM_ID_PATTERN = /^[A-Z0-9]{4,12}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

type RoomRow = {
  id: string;
  ownerId: string | null;
  passwordHash: string | null;
  accessVersion: number;
};

export function normalizeRoomId(value: unknown) {
  const roomId = typeof value === "string" ? value.trim().toUpperCase() : "";
  return ROOM_ID_PATTERN.test(roomId) ? roomId : null;
}

function generateRoomId(length = 6) {
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

function roomSecret() {
  return process.env.ROOM_TOKEN_SECRET || "";
}

export function createRoomToken(input: {
  roomId: string;
  user: ApiUser;
  accessVersion: number;
}) {
  const secret = roomSecret();
  if (!secret) return null;
  const payload = Buffer.from(
    JSON.stringify({
      r: input.roomId,
      u: input.user.id,
      n: input.user.name ?? input.user.email,
      i: input.user.image,
      v: input.accessVersion,
      exp: Date.now() + TOKEN_TTL_MS,
    })
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function password(value: unknown) {
  return typeof value === "string" && value.length >= 4 && value.length <= 64 ? value : null;
}

async function findOrClaimRoom(roomId: string, userId: string) {
  const { rows } = await query<RoomRow>(
    `INSERT INTO "Room" (id, "ownerId", "createdAt", "updatedAt")
     VALUES ($1, $2, now(), now())
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING id, "ownerId", "passwordHash", "accessVersion"`,
    [roomId, userId]
  );
  let room = rows[0];
  // Rooms from before ownership existed are claimed by their next visitor.
  if (!room.ownerId && !room.passwordHash) {
    const claimed = await query<RoomRow>(
      `UPDATE "Room" SET "ownerId" = $2, "updatedAt" = now()
       WHERE id = $1 AND "ownerId" IS NULL AND "passwordHash" IS NULL
       RETURNING id, "ownerId", "passwordHash", "accessVersion"`,
      [roomId, userId]
    );
    room = claimed.rows[0] ?? room;
  }
  return room;
}

export async function roomAccess(roomId: string, user: ApiUser) {
  const room = await findOrClaimRoom(roomId, user.id);
  const isOwner = room.ownerId === user.id;
  const isPrivate = room.passwordHash !== null;
  let hasAccess = !isPrivate || isOwner;
  if (!hasAccess) {
    const { rowCount } = await query(
      'SELECT 1 FROM "RoomVisit" WHERE "userId" = $1 AND "roomId" = $2',
      [user.id, roomId]
    );
    hasAccess = (rowCount ?? 0) > 0;
  }
  if (hasAccess) await recordVisit(user.id, roomId);

  return {
    roomId,
    isOwner,
    isPrivate,
    hasAccess,
    accessVersion: room.accessVersion,
    token: hasAccess ? createRoomToken({ roomId, user, accessVersion: room.accessVersion }) : null,
  };
}

export async function createRoom(user: ApiUser, input: unknown) {
  const suppliedPassword = (input as Record<string, unknown>)?.password;
  if (suppliedPassword !== undefined && !password(suppliedPassword)) {
    return { error: "Use a room password between 4 and 64 characters." };
  }
  const passwordHash =
    suppliedPassword === undefined ? null : await bcrypt.hash(suppliedPassword as string, 10);

  for (let attempt = 0; attempt < 5; attempt++) {
    const roomId = generateRoomId();
    try {
      await query(
        `INSERT INTO "Room" (id, "ownerId", "passwordHash", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, now(), now())`,
        [roomId, user.id, passwordHash]
      );
      await recordVisit(user.id, roomId);
      return { roomId };
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
    }
  }
  return { error: "Couldn't create the room. Please try again." };
}

export async function unlockRoom(roomId: string, user: ApiUser, input: unknown) {
  const suppliedPassword = (input as Record<string, unknown>)?.password;
  if (typeof suppliedPassword !== "string") return { error: "Enter the room password." };
  const { rows } = await query<{ passwordHash: string | null }>(
    'SELECT "passwordHash" FROM "Room" WHERE id = $1',
    [roomId]
  );
  const room = rows[0];
  if (!room) return { error: "Room not found." };
  if (room.passwordHash && !(await bcrypt.compare(suppliedPassword, room.passwordHash))) {
    return { error: "Wrong password." };
  }
  await recordVisit(user.id, roomId);
  return { roomId };
}

export async function updateRoomPassword(roomId: string, user: ApiUser, input: unknown) {
  const suppliedPassword = (input as Record<string, unknown>)?.password;
  const newPassword = password(suppliedPassword);
  if (suppliedPassword !== null && !newPassword) {
    return { error: "Use a room password between 4 and 64 characters." };
  }
  const { rows } = await query<{ ownerId: string | null }>(
    'SELECT "ownerId" FROM "Room" WHERE id = $1',
    [roomId]
  );
  if (!rows[0] || rows[0].ownerId !== user.id) return { error: "Only the room owner can change this." };

  const passwordHash = suppliedPassword === null ? null : await bcrypt.hash(newPassword!, 10);
  const { rows: updated } = await query<{ accessVersion: number }>(
    `UPDATE "Room"
     SET "passwordHash" = $2, "accessVersion" = "accessVersion" + 1, "updatedAt" = now()
     WHERE id = $1
     RETURNING "accessVersion"`,
    [roomId, passwordHash]
  );
  await query('DELETE FROM "RoomVisit" WHERE "roomId" = $1 AND "userId" <> $2', [roomId, user.id]);
  await revokeRoomAccess(roomId, updated[0].accessVersion);
  return { roomId };
}

async function recordVisit(userId: string, roomId: string) {
  try {
    await query(
      `INSERT INTO "RoomVisit" ("userId", "roomId", "visitedAt") VALUES ($1, $2, now())
       ON CONFLICT ("userId", "roomId") DO UPDATE SET "visitedAt" = now()`,
      [userId, roomId]
    );
  } catch (error) {
    console.error("[rooms] Failed to record recent room", error);
  }
}

async function revokeRoomAccess(roomId: string, accessVersion: number) {
  const secret = roomSecret();
  const backendUrl = process.env.BACKEND_URL;
  if (!secret || !backendUrl) return;
  try {
    await fetch(`${backendUrl}/internal/rooms/${roomId}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ accessVersion }),
      signal: AbortSignal.timeout(4000),
    });
  } catch (error) {
    console.error("[rooms] Failed to revoke stale room tokens", error);
  }
}

export async function recentRooms(userId: string, take = 6) {
  const { rows } = await query<{
    id: string;
    visitedAt: Date;
    isPrivate: boolean;
    elements: DrawElement[];
  }>(
    `SELECT rv."roomId" AS id, rv."visitedAt" AS "visitedAt",
            r."passwordHash" IS NOT NULL AS "isPrivate", r.elements
     FROM "RoomVisit" rv
     JOIN "Room" r ON r.id = rv."roomId"
     WHERE rv."userId" = $1
     ORDER BY rv."visitedAt" DESC
     LIMIT $2`,
    [userId, take]
  );
  return rows;
}
