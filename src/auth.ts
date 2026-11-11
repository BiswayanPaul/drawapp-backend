import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { query } from "./database";

export type ApiUser = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
};

type SessionPayload = { sub: string; exp: number };

const SESSION_COOKIE = "drawapp_session";
const OAUTH_STATE_COOKIE = "drawapp_oauth_state";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function secret() {
  // AUTH_SECRET is kept for a straightforward migration from NextAuth.
  return process.env.AUTH_SECRET || process.env.SESSION_SECRET || "";
}

function sign(value: string) {
  const key = secret();
  return key ? createHmac("sha256", key).update(value).digest("base64url") : "";
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function encode(payload: object) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(body);
  return signature ? `${body}.${signature}` : null;
}

function decode<T>(value: string | undefined): T | null {
  if (!value) return null;
  const [body, signature] = value.split(".");
  if (!body || !signature || !safeEqual(sign(body), signature)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as T;
  } catch {
    return null;
  }
}

function cookies(req: Request) {
  return Object.fromEntries(
    (req.header("cookie") ?? "")
      .split(";")
      .map((part) => {
        const separator = part.indexOf("=");
        return separator < 0
          ? [part.trim(), ""]
          : [part.slice(0, separator).trim(), part.slice(separator + 1)];
      })
      .filter(([key]) => key)
      .map(([key, value]) => [key, decodeURIComponent(value ?? "")])
  );
}

function cookieOptions(maxAge: number) {
  // The frontend proxies /api/* here, so cookies are first-party on FRONTEND_URL's
  // host and Lax is enough (it still rides the top-level OAuth callback redirect).
  const secure = process.env.FRONTEND_URL?.startsWith("https://") ?? false;
  return [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
    `Max-Age=${maxAge}`,
  ].join("; ");
}

// Same path NextAuth used, so the redirect URIs already registered with Google keep working.
function googleRedirectUri() {
  const frontendUrl = process.env.FRONTEND_URL?.replace(/\/$/, "");
  return frontendUrl ? `${frontendUrl}/api/auth/callback/google` : null;
}

function writeCookie(res: Response, name: string, value: string, maxAge: number) {
  res.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; ${cookieOptions(maxAge)}`);
}

function sessionToken(userId: string) {
  return encode({ sub: userId, exp: Date.now() + SESSION_TTL_MS });
}

export function setSession(res: Response, userId: string) {
  const token = sessionToken(userId);
  if (!token) throw new Error("AUTH_SECRET or SESSION_SECRET must be configured");
  writeCookie(res, SESSION_COOKIE, token, Math.floor(SESSION_TTL_MS / 1000));
}

export function clearSession(res: Response) {
  writeCookie(res, SESSION_COOKIE, "", 0);
}

export function clearOauthState(res: Response) {
  writeCookie(res, OAUTH_STATE_COOKIE, "", 0);
}

export async function currentUser(req: Request): Promise<ApiUser | null> {
  const session = decode<SessionPayload>(cookies(req)[SESSION_COOKIE]);
  if (!session || typeof session.sub !== "string" || session.exp < Date.now()) return null;
  const { rows } = await query<ApiUser>(
    'SELECT id, name, email, image FROM "User" WHERE id = $1',
    [session.sub]
  );
  return rows[0] ?? null;
}

export function requireUser(req: Request, res: Response, next: (user: ApiUser) => void) {
  currentUser(req)
    .then((user) => {
      if (!user) {
        res.status(401).json({ error: "Please sign in again." });
        return;
      }
      next(user);
    })
    .catch((error) => {
      console.error("[auth] Failed to load session", error);
      res.status(500).json({ error: "Couldn't verify your session. Please try again." });
    });
}

export function validateCredentials(input: unknown) {
  const values = input as Record<string, unknown>;
  const email = typeof values?.email === "string" ? values.email.trim().toLowerCase() : "";
  const password = typeof values?.password === "string" ? values.password : "";
  if (!/^\S+@\S+\.\S+$/.test(email) || !password) return null;
  return { email, password };
}

export function validateRegistration(input: unknown) {
  const credentials = validateCredentials(input);
  const values = input as Record<string, unknown>;
  const name = typeof values?.name === "string" ? values.name.trim() : "";
  if (!credentials || credentials.password.length < 6 || !name || name.length > 60) return null;
  return { ...credentials, name };
}

export async function createCredentialsUser(input: unknown) {
  const values = validateRegistration(input);
  if (!values) return { error: "Enter a name, valid email, and password of at least 6 characters." };

  const passwordHash = await bcrypt.hash(values.password, 10);
  try {
    const { rows } = await query<ApiUser>(
      `INSERT INTO "User" (id, name, email, password, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, now(), now())
       RETURNING id, name, email, image`,
      [randomUUID(), values.name, values.email, passwordHash]
    );
    return { user: rows[0] };
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      return { error: "An account with this email already exists." };
    }
    throw error;
  }
}

export async function authenticateCredentials(input: unknown) {
  const values = validateCredentials(input);
  if (!values) return { error: "Enter a valid email and password." };

  const { rows } = await query<ApiUser & { password: string | null }>(
    'SELECT id, name, email, image, password FROM "User" WHERE email = $1',
    [values.email]
  );
  const user = rows[0];
  if (!user?.password || !(await bcrypt.compare(values.password, user.password))) {
    return { error: "Invalid email or password." };
  }
  const { password: _password, ...safeUser } = user;
  return { user: safeUser };
}

function makeOauthState() {
  return encode({ nonce: randomBytes(20).toString("base64url"), exp: Date.now() + OAUTH_STATE_TTL_MS });
}

export function beginGoogleAuth(req: Request, res: Response) {
  const clientId = process.env.AUTH_GOOGLE_ID;
  const redirectUri = googleRedirectUri();
  if (!clientId || !redirectUri || !secret()) {
    res.status(503).json({ error: "Google sign-in is not configured." });
    return;
  }
  const state = makeOauthState();
  if (!state) {
    res.status(503).json({ error: "Authentication is not configured." });
    return;
  }
  writeCookie(res, OAUTH_STATE_COOKIE, state, Math.floor(OAUTH_STATE_TTL_MS / 1000));
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  }).toString();
  res.redirect(url.toString());
}

export async function finishGoogleAuth(req: Request, res: Response) {
  const frontendUrl = process.env.FRONTEND_URL;
  const redirectUri = googleRedirectUri();
  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const storedState = cookies(req)[OAUTH_STATE_COOKIE];
  const parsedState = decode<{ exp: number }>(state);
  const fail = (reason: string) => res.redirect(`${frontendUrl ?? ""}/signin?error=${reason}`);

  clearOauthState(res);
  if (
    !frontendUrl ||
    !redirectUri ||
    !clientId ||
    !clientSecret ||
    !code ||
    !storedState ||
    !safeEqual(state, storedState) ||
    !parsedState ||
    parsedState.exp < Date.now()
  ) {
    fail("oauth");
    return;
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokens = (await tokenResponse.json()) as { access_token?: string };
    if (!tokenResponse.ok || !tokens.access_token) throw new Error("Google token exchange failed");

    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = (await profileResponse.json()) as {
      email?: string;
      name?: string;
      picture?: string;
    };
    if (!profileResponse.ok || !profile.email) throw new Error("Google profile is missing an email");

    const email = profile.email.toLowerCase();
    const { rows } = await query<ApiUser>(
      `INSERT INTO "User" (id, name, email, image, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (email) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, "User".name),
         image = COALESCE(EXCLUDED.image, "User".image),
         "updatedAt" = now()
       RETURNING id, name, email, image`,
      [randomUUID(), profile.name?.slice(0, 60) ?? null, email, profile.picture ?? null]
    );
    setSession(res, rows[0].id);
    res.redirect(frontendUrl);
  } catch (error) {
    console.error("[auth] Google sign-in failed", error);
    fail("oauth");
  }
}
