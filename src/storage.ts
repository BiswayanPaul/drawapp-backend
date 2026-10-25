import { Pool } from "pg";
import type { DrawElement } from "./elements";

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
  return new Pool({
    connectionString: url.toString(),
    ssl: sslmode && sslmode !== "disable" ? { rejectUnauthorized: false } : undefined,
    max: 3,
  });
}

const pool = createPool();

// Returns null when the room couldn't be read, so callers never overwrite it blindly.
export async function loadRoom(
  roomId: string
): Promise<{ elements: DrawElement[]; accessVersion: number } | null> {
  if (!pool) return { elements: [], accessVersion: 0 };
  try {
    const { rows } = await pool.query(
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
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO "Room" (id, elements, "createdAt", "updatedAt")
       VALUES ($1, $2, now(), now())
       ON CONFLICT (id) DO UPDATE SET elements = $2, "updatedAt" = now()`,
      [roomId, JSON.stringify(elements)]
    );
  } catch (error) {
    console.error(`Failed to save room ${roomId}`, error);
  }
}
