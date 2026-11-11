# DrawApp backend

This Express service owns every server-side concern: credential and Google
authentication, signed browser sessions, room authorization, PostgreSQL
migrations/persistence, recent-room data, and the realtime WebSocket service.

## Local setup

1. Copy `.env.example` to `.env` and supply PostgreSQL plus long random secrets.
2. In Google Cloud, set the authorized redirect URI to
   `http://localhost:3000/api/auth/callback/google` (the frontend proxies `/api/*` here).
3. Run `npm install` and then `npm run build`. The build deploys Prisma migrations
   before compiling the TypeScript service.
4. Run `npm run dev`.

The frontend needs no configuration in development: it proxies `/api/*` to
`http://localhost:8080` and opens sockets at `ws://localhost:8080`.

## Deployment

Set `FRONTEND_URL` to the exact frontend origin (no trailing slash), e.g.
`https://drawapp-frontend.vercel.app`. The frontend proxies `/api/*` to this
service, so the session cookie is first-party on that origin and Google's redirect
URI is `${FRONTEND_URL}/api/auth/callback/google`. WebSockets connect directly.
