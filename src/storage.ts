import type { DrawElement } from "./elements";
import { databaseAvailable, query } from "./database";

// Persistence is optional: without DATABASE_URL rooms simply live in memory.
// Returns null when the room couldn't be read, so callers never overwrite it blindly.
export async function loadRoom(
  roomId: string
): Promise<{ elements: DrawElement[]; accessVersion: number } | null> {
  if (!databaseAvailable()) return { elements: [], accessVersion: 0 };
  try {
    const { rows } = await query(
      'SELECT elements, "accessVersion" FROM "Room" WHERE id = $1',
      [roomId]
    );
    return {
      elements: Array.isArray(rows[0]?.elements) ? rows[0].elements : [],
      accessVersion: rows[0]?.accessVersion ?? 0,
    };
  } catch (error) {
    console.error(`Failed to load room ${roomId}`, error);
    return null;
  }
}

export async function saveRoom(roomId: string, elements: DrawElement[]) {
  if (!databaseAvailable()) return;
  try {
    await query(
      `INSERT INTO "Room" (id, elements, "createdAt", "updatedAt")
       VALUES ($1, $2, now(), now())
       ON CONFLICT (id) DO UPDATE SET elements = $2, "updatedAt" = now()`,
      [roomId, JSON.stringify(elements)]
    );
  } catch (error) {
    console.error(`Failed to save room ${roomId}`, error);
  }
}
