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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setSession = setSession;
exports.clearSession = clearSession;
exports.clearOauthState = clearOauthState;
exports.currentUser = currentUser;
exports.requireUser = requireUser;
exports.validateCredentials = validateCredentials;
exports.validateRegistration = validateRegistration;
exports.createCredentialsUser = createCredentialsUser;
exports.authenticateCredentials = authenticateCredentials;
exports.beginGoogleAuth = beginGoogleAuth;
exports.finishGoogleAuth = finishGoogleAuth;
const crypto_1 = require("crypto");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const database_1 = require("./database");
const SESSION_COOKIE = "drawapp_session";
const OAUTH_STATE_COOKIE = "drawapp_oauth_state";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
function secret() {
    // AUTH_SECRET is kept for a straightforward migration from NextAuth.
    return process.env.AUTH_SECRET || process.env.SESSION_SECRET || "";
}
function sign(value) {
    const key = secret();
    return key ? (0, crypto_1.createHmac)("sha256", key).update(value).digest("base64url") : "";
}
function safeEqual(left, right) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && (0, crypto_1.timingSafeEqual)(a, b);
}
function encode(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = sign(body);
    return signature ? `${body}.${signature}` : null;
}
function decode(value) {
    if (!value)
        return null;
    const [body, signature] = value.split(".");
    if (!body || !signature || !safeEqual(sign(body), signature))
        return null;
    try {
        return JSON.parse(Buffer.from(body, "base64url").toString());
    }
    catch (_a) {
        return null;
    }
}
function cookies(req) {
    var _a;
    return Object.fromEntries(((_a = req.header("cookie")) !== null && _a !== void 0 ? _a : "")
        .split(";")
        .map((part) => {
        const separator = part.indexOf("=");
        return separator < 0
            ? [part.trim(), ""]
            : [part.slice(0, separator).trim(), part.slice(separator + 1)];
    })
        .filter(([key]) => key)
        .map(([key, value]) => [key, decodeURIComponent(value !== null && value !== void 0 ? value : "")]));
}
function cookieOptions(maxAge) {
    var _a, _b;
    // The frontend proxies /api/* here, so cookies are first-party on FRONTEND_URL's
    // host and Lax is enough (it still rides the top-level OAuth callback redirect).
    const secure = (_b = (_a = process.env.FRONTEND_URL) === null || _a === void 0 ? void 0 : _a.startsWith("https://")) !== null && _b !== void 0 ? _b : false;
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
    var _a;
    const frontendUrl = (_a = process.env.FRONTEND_URL) === null || _a === void 0 ? void 0 : _a.replace(/\/$/, "");
    return frontendUrl ? `${frontendUrl}/api/auth/callback/google` : null;
}
function writeCookie(res, name, value, maxAge) {
    res.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; ${cookieOptions(maxAge)}`);
}
function sessionToken(userId) {
    return encode({ sub: userId, exp: Date.now() + SESSION_TTL_MS });
}
function setSession(res, userId) {
    const token = sessionToken(userId);
    if (!token)
        throw new Error("AUTH_SECRET or SESSION_SECRET must be configured");
    writeCookie(res, SESSION_COOKIE, token, Math.floor(SESSION_TTL_MS / 1000));
}
function clearSession(res) {
    writeCookie(res, SESSION_COOKIE, "", 0);
}
function clearOauthState(res) {
    writeCookie(res, OAUTH_STATE_COOKIE, "", 0);
}
function currentUser(req) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const session = decode(cookies(req)[SESSION_COOKIE]);
        if (!session || typeof session.sub !== "string" || session.exp < Date.now())
            return null;
        const { rows } = yield (0, database_1.query)('SELECT id, name, email, image FROM "User" WHERE id = $1', [session.sub]);
        return (_a = rows[0]) !== null && _a !== void 0 ? _a : null;
    });
}
function requireUser(req, res, next) {
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
function validateCredentials(input) {
    const values = input;
    const email = typeof (values === null || values === void 0 ? void 0 : values.email) === "string" ? values.email.trim().toLowerCase() : "";
    const password = typeof (values === null || values === void 0 ? void 0 : values.password) === "string" ? values.password : "";
    if (!/^\S+@\S+\.\S+$/.test(email) || !password)
        return null;
    return { email, password };
}
function validateRegistration(input) {
    const credentials = validateCredentials(input);
    const values = input;
    const name = typeof (values === null || values === void 0 ? void 0 : values.name) === "string" ? values.name.trim() : "";
    if (!credentials || credentials.password.length < 6 || !name || name.length > 60)
        return null;
    return Object.assign(Object.assign({}, credentials), { name });
}
function createCredentialsUser(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const values = validateRegistration(input);
        if (!values)
            return { error: "Enter a name, valid email, and password of at least 6 characters." };
        const passwordHash = yield bcryptjs_1.default.hash(values.password, 10);
        try {
            const { rows } = yield (0, database_1.query)(`INSERT INTO "User" (id, name, email, password, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, now(), now())
       RETURNING id, name, email, image`, [(0, crypto_1.randomUUID)(), values.name, values.email, passwordHash]);
            return { user: rows[0] };
        }
        catch (error) {
            if (error.code === "23505") {
                return { error: "An account with this email already exists." };
            }
            throw error;
        }
    });
}
function authenticateCredentials(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const values = validateCredentials(input);
        if (!values)
            return { error: "Enter a valid email and password." };
        const { rows } = yield (0, database_1.query)('SELECT id, name, email, image, password FROM "User" WHERE email = $1', [values.email]);
        const user = rows[0];
        if (!(user === null || user === void 0 ? void 0 : user.password) || !(yield bcryptjs_1.default.compare(values.password, user.password))) {
            return { error: "Invalid email or password." };
        }
        const { password: _password } = user, safeUser = __rest(user, ["password"]);
        return { user: safeUser };
    });
}
function makeOauthState() {
    return encode({ nonce: (0, crypto_1.randomBytes)(20).toString("base64url"), exp: Date.now() + OAUTH_STATE_TTL_MS });
}
function beginGoogleAuth(req, res) {
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
function finishGoogleAuth(req, res) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c;
        const frontendUrl = process.env.FRONTEND_URL;
        const redirectUri = googleRedirectUri();
        const clientId = process.env.AUTH_GOOGLE_ID;
        const clientSecret = process.env.AUTH_GOOGLE_SECRET;
        const state = typeof req.query.state === "string" ? req.query.state : "";
        const code = typeof req.query.code === "string" ? req.query.code : "";
        const storedState = cookies(req)[OAUTH_STATE_COOKIE];
        const parsedState = decode(state);
        const fail = (reason) => res.redirect(`${frontendUrl !== null && frontendUrl !== void 0 ? frontendUrl : ""}/signin?error=${reason}`);
        clearOauthState(res);
        if (!frontendUrl ||
            !redirectUri ||
            !clientId ||
            !clientSecret ||
            !code ||
            !storedState ||
            !safeEqual(state, storedState) ||
            !parsedState ||
            parsedState.exp < Date.now()) {
            fail("oauth");
            return;
        }
        try {
            const tokenResponse = yield fetch("https://oauth2.googleapis.com/token", {
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
            const tokens = (yield tokenResponse.json());
            if (!tokenResponse.ok || !tokens.access_token)
                throw new Error("Google token exchange failed");
            const profileResponse = yield fetch("https://openidconnect.googleapis.com/v1/userinfo", {
                headers: { authorization: `Bearer ${tokens.access_token}` },
            });
            const profile = (yield profileResponse.json());
            if (!profileResponse.ok || !profile.email)
                throw new Error("Google profile is missing an email");
            const email = profile.email.toLowerCase();
            const { rows } = yield (0, database_1.query)(`INSERT INTO "User" (id, name, email, image, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (email) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, "User".name),
         image = COALESCE(EXCLUDED.image, "User".image),
         "updatedAt" = now()
       RETURNING id, name, email, image`, [(0, crypto_1.randomUUID)(), (_b = (_a = profile.name) === null || _a === void 0 ? void 0 : _a.slice(0, 60)) !== null && _b !== void 0 ? _b : null, email, (_c = profile.picture) !== null && _c !== void 0 ? _c : null]);
            setSession(res, rows[0].id);
            res.redirect(frontendUrl);
        }
        catch (error) {
            console.error("[auth] Google sign-in failed", error);
            fail("oauth");
        }
    });
}
