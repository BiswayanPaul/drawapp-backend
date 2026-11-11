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
exports.databaseAvailable = databaseAvailable;
exports.query = query;
const pg_1 = require("pg");
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
    const pool = new pg_1.Pool({
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
function databaseAvailable() {
    return pool !== null;
}
function query(text_1) {
    return __awaiter(this, arguments, void 0, function* (text, values = []) {
        if (!pool)
            throw new Error("DATABASE_URL is not configured");
        return pool.query(text, values);
    });
}
