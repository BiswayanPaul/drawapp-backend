import { Pool, type QueryResultRow } from "pg";

// The HTTP API and the realtime persistence layer deliberately share one pool.
// This service is the only application process that talks to Postgres.
function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn("DATABASE_URL not set; database-backed features are unavailable.");
    return null;
  }

  const url = new URL(connectionString);
  const sslmode = url.searchParams.get("sslmode");
  // Managed Postgres providers often use a CA which isn't in Node's default
  // trust store. sslmode=require means encrypt, rather than reject the connection.
  url.searchParams.delete("sslmode");
  const pool = new Pool({
    connectionString: url.toString(),
    ssl: sslmode && sslmode !== "disable" ? { rejectUnauthorized: false } : undefined,
    max: 5,
    // Fail fast instead of hanging requests while the database is powered off.
    connectionTimeoutMillis: 10000,
  });
  // An idle client dropping (database restart, provider maintenance) emits this;
  // without a listener Node treats it as uncaught and the whole service exits.
  pool.on("error", (error) => console.error("[db] Idle client error", error));
  return pool;
}

const pool = createPool();

export function databaseAvailable() {
  return pool !== null;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
) {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool.query<T>(text, values);
}
