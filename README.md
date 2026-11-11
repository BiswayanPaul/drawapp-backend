# DrawApp backend

This Express service owns every server-side concern: credential and Google
authentication, signed browser sessions, room authorization, PostgreSQL
migrations/persistence, recent-room data, and the realtime WebSocket service.

## Local setup

1. Copy `.env.example` to `.env` and supply PostgreSQL plus long random secrets.
2. In Google Cloud, set the authorized redirect URI to
   `http://localhost:8080/api/auth/google/callback`.
3. Run `npm install` and then `npm run build`. The build deploys Prisma migrations
   before compiling the TypeScript service.
4. Run `npm run dev`.

Set `NEXT_PUBLIC_API_URL=http://localhost:8080` and
`NEXT_PUBLIC_WS_URL=ws://localhost:8080` in the frontend.

## Deployment

Set `BACKEND_URL` to the externally reachable backend URL and `FRONTEND_URL` to
the exact frontend origin (no trailing slash). In production the session cookie is
`Secure` and `SameSite=None`, so HTTPS is required. Use a same-site custom domain
for the frontend and API when possible; browsers can block third-party cookies on
unrelated domains.
