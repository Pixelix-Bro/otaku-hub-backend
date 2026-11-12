# XENVO Media Backend

This repository is a Fastify + MongoDB backend. It is not a PostgreSQL project and has no separate frontend framework application; a token-protected native HTML5 player is served by the backend at `/watch/:mediaId`.

## Core principles

- Telegram Bot API is used for bot webhooks and bot admin flow.
- Telegram Bot API is used for bot webhooks and storage-channel copies; Teleproto MTProto reads storage-channel media for direct byte-range delivery when configured.
- MongoDB stores metadata, message IDs, admin records, and token state.
- The Telegram bot copies uploads into the configured private storage channel; that is an existing storage requirement, not a public channel.
- The public API exposes watch-token-protected media access, not raw Telegram file links.
- Streaming endpoints implement byte ranges and HTTP 200/206/304/416 semantics without buffering the complete media file.

## Environment contract

Copy [.env.example](.env.example) and replace the placeholders with real values.

Required backend variables are `BOT_TOKEN`, `TELEGRAM_STORAGE_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ADMIN_IDS` (or legacy `ADMIN_TELEGRAM_IDS`), `MONGODB_URI`, and `MEDIA_LINK_SECRET`. Set `PUBLIC_API_URL` (or legacy `PUBLIC_BASE_URL`) to the backend's public HTTPS URL in production so the Telegram webhook and watch links can be configured. `ADMIN_API_TOKEN` is required only if HTTP admin routes should be enabled. `MONGODB_DB`, `WATCH_TOKEN_TTL_SECONDS`, and `MAX_WATCH_TOKEN_USES` have defaults. Set `TELEGRAM_BOT_API_BASE_URL` only when using a non-hosted Bot API endpoint; the old `TELEGRAM_API_BASE_URL` name remains supported.

MTProto streaming requires `TELEGRAM_MTPROTO_API_ID` and `TELEGRAM_MTPROTO_API_HASH` from `my.telegram.org`; `BOT_TOKEN` authorizes the bot session. Keep all three server-side and never expose them to browser code. `TELEGRAM_MTPROTO_SESSION` is an optional secret for persisting the MTProto auth session across restarts. Without the API ID/hash, small-file preview can fall back to the hosted Bot API, but the hosted API's `getFile` limit is 20 MiB; larger streams return HTTP 503 with setup guidance. A configured Local Bot API endpoint is also retained as a fallback, but MTProto is the direct-range reader.

The bot MTProto login uses the existing bot token, not a user account. Store API credentials and the session in the backend's secret manager. If no session is supplied, the client authenticates in memory at startup and logs a warning; provide a persistent session for stable production restarts. The backend does not print or return the session string.

Legacy keys remain accepted for backward compatibility, including `TELEGRAM_BOT_TOKEN` and `ADMIN_TELEGRAM_IDS`.

## Local development

Set the required bot/backend variables in `.env`. To enable MTProto, add the API ID and API hash as backend secrets; optionally set the bot session string. The backend can start without these credentials, but hosted Bot API downloads remain limited to 20 MiB.

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
- Telegram Bot API endpoint via `TELEGRAM_BOT_API_BASE_URL` (`TELEGRAM_API_BASE_URL` remains an alias)
- Optional MTProto range streaming via `TELEGRAM_MTPROTO_API_ID` and `TELEGRAM_MTPROTO_API_HASH`
- Dockerfile for the API service

The backend receives Telegram webhook JSON and copies messages server-side; it does not accept raw video uploads, so Fastify's JSON body limit is not a media-size limit. Streaming uses Node readable streams and HTTP ranges; a new browser range request can resume after an interrupted connection. It does not spool full files to backend RAM or temporary disk.

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

Railway manages its edge proxy, disk and network quotas; this repository cannot change Railway's buffering or timeout policy. Add MTProto credentials/session as backend secrets and verify channel access plus long-running range responses in the deployed environment. No video copies are stored on the application filesystem; Telegram remains the only persistent video store.

## Notes

This codebase keeps an operational boundary between Telegram storage and the public streaming gateway. Public media metadata does not expose raw Telegram file URLs, file IDs, or storage chat metadata. MongoDB fields are added/indexed at startup; no PostgreSQL migration exists because the repository uses MongoDB.
