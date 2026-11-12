# XENVO Media Backend

This repository is a Fastify + MongoDB backend. It is not a PostgreSQL project and has no separate frontend framework application; a token-protected native HTML5 player is served by the backend at `/watch/:mediaId`.

## Core principles

- Telegram Bot API is used for bot webhooks and bot admin flow.
- Official Telegram Local Bot API Server is used for bot requests and media download access.
- MongoDB stores metadata, message IDs, admin records, and token state.
- The Telegram bot copies uploads into the configured private storage channel; that is an existing storage requirement, not a public channel.
- The public API exposes watch-token-protected media access, not raw Telegram file links.
- Streaming endpoints implement byte ranges and HTTP 206/416 semantics; live Telegram streaming is supported through the configured Local Bot API server and production deployment.

## Environment contract

Copy [.env.example](.env.example) and replace the placeholders with real values.

Required backend variables are `BOT_TOKEN`, `TELEGRAM_STORAGE_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ADMIN_IDS` (or legacy `ADMIN_TELEGRAM_IDS`), `MONGODB_URI`, and `MEDIA_LINK_SECRET`. Set `PUBLIC_API_URL` (or legacy `PUBLIC_BASE_URL`) to the backend's public HTTPS URL in production so the Telegram webhook and watch links can be configured. `ADMIN_API_TOKEN` is required only if HTTP admin routes should be enabled. `MONGODB_DB`, `WATCH_TOKEN_TTL_SECONDS`, `MAX_WATCH_TOKEN_USES`, and `BOT_API_DOWNLOAD_MAX_BYTES` have defaults.

For Local Bot API, set `TELEGRAM_API_BASE_URL`, `TELEGRAM_API_ID`, and `TELEGRAM_API_HASH` when pointing at a local Bot API server instead of the hosted Telegram API. The backend no longer depends on a separate worker service.

Legacy keys remain accepted for backward compatibility, including `TELEGRAM_BOT_TOKEN` and `ADMIN_TELEGRAM_IDS`.

## Local development

Set the required bot/backend variables in `.env`. The backend uses the official Telegram Local Bot API server when `TELEGRAM_API_BASE_URL` is configured to a local service. In that mode, also provide `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`.

```bash
npm install
npm run build
npm test
```

```bash
npm run dev
```

## Runtime behavior

The app exposes:

- Health checks at `/health/live` and `/health/ready`
- A Telegram inline admin dashboard with live DB/Bot API/storage/website checks
- Paginated and filtered admin library, media details, statistics, monitoring, and confirmed deletion callbacks
- Token-protected native HTML5 playback page at `/watch/:mediaId`
- Public watch metadata routes under `/api/media` and `/v1/media`
- Range-aware preview streaming under `/api/stream/:mediaId` and `/v1/preview/:mediaId`
- Telegram bot webhook setup and admin validation hooks

## Deployment

The API service is prepared for Railway or Docker-style deployment with:

- Fastify server runtime
- MongoDB health checks
- health endpoints
- Telegram Local Bot API compatibility via `TELEGRAM_API_BASE_URL`
- Dockerfile for the API service

If deploying behind Nginx, disable response buffering for the streaming paths and allow long reads, for example:

```nginx
location ~ ^/(api/stream|v1/preview)/ {
	proxy_pass http://xenvo_api;
	proxy_buffering off;
	proxy_request_buffering off;
	proxy_read_timeout 1h;
	proxy_send_timeout 1h;
}
```

Railway manages its edge proxy; this repository cannot change Railway's buffering or timeout policy. Verify long-running range responses in the chosen hosting plan before declaring production playback support.

## Notes

This codebase keeps an operational boundary between Telegram storage and the public streaming gateway. Public media metadata does not expose raw Telegram file URLs, file IDs, or storage chat metadata. MongoDB fields are added/indexed at startup; no PostgreSQL migration exists because the repository uses MongoDB.
