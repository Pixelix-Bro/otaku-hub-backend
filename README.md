# XENVO Media Backend

This repository is a Fastify + MongoDB backend. It is not a PostgreSQL project and has no separate frontend framework application; a token-protected native HTML5 player is served by the backend at `/watch/:mediaId`.

## Core principles

- Telegram Bot API is used for bot webhooks and bot admin flow.
- MTProto bot authorization is used by a dedicated Telethon worker for range-based file retrieval.
- MongoDB stores metadata, message IDs, admin records, and token state.
- The Telegram bot copies uploads into the configured private storage channel; that is an existing storage requirement, not a public channel.
- The public API exposes watch-token-protected media access, not raw Telegram file links.
- Streaming endpoints implement byte ranges and HTTP 206/416 semantics; live Telegram streaming has not been verified without production credentials and a deployed worker.

## Environment contract

Copy [.env.example](.env.example) and replace the placeholders with real values.

Required variables include:

- `BOT_TOKEN`
- `TELEGRAM_STORAGE_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_ADMIN_IDS`
- `ADMIN_API_TOKEN` for HTTP admin routes (required to enable them)
- `MONGODB_URI`
- `MONGODB_DB`
- `MEDIA_LINK_SECRET`
- `PUBLIC_BASE_URL`
- `WATCH_TOKEN_TTL_SECONDS`
- `MAX_WATCH_TOKEN_USES`
- `STREAM_CHUNK_BYTES`
- `MEDIA_CHUNK_CACHE_BYTES`

Legacy keys remain accepted for backward compatibility, including `TELEGRAM_BOT_TOKEN` and `ADMIN_TELEGRAM_IDS`.

## Local development

Set the required bot/backend variables in `.env`. MTProto is an optional all-or-none group: set `API_ID`, `API_HASH`, `TELEGRAM_WORKER_URL`, and `TELEGRAM_WORKER_SECRET` together to enable worker streaming. Without them the bot and small Bot API previews can run, but large-file streaming stays unavailable and readiness reports the worker offline. When enabling it locally, use `http://127.0.0.1:8000` and the same secret for API and worker.

```bash
npm install
npm run build
npm test
```

```bash
pip install -r workers/requirements.txt
uvicorn mtproto_worker:app --app-dir workers --host 127.0.0.1 --port 8000
```

```bash
npm run dev
```

## Runtime behavior

The app exposes:

- Health checks at `/health/live` and `/health/ready`
- A Telegram inline admin dashboard with live DB/Bot API/storage/worker/website checks
- Paginated and filtered admin library, media details, statistics, monitoring, and confirmed deletion callbacks
- Token-protected native HTML5 playback page at `/watch/:mediaId`
- Public watch metadata routes under `/api/media` and `/v1/media`
- Range-aware preview streaming under `/api/stream/:mediaId` and `/v1/preview/:mediaId`
- Telegram bot webhook setup and admin validation hooks

## MTProto worker

Large-file web preview uses the separate Telethon service in [workers/mtproto_worker.py](workers/mtproto_worker.py). The API issues a large-file link only after the worker resolves the stored source message and records MTProto document metadata. The worker must be running, use the same secret, and have access to the configured private storage chat.

For local development, install the worker dependencies and run:

```bash
pip install -r workers/requirements.txt
uvicorn mtproto_worker:app --app-dir workers --host 127.0.0.1 --port 8000
```

For Railway, create a second service from this repository and set its Dockerfile path to `workers/Dockerfile`. Add a persistent volume mounted at `/data`, and configure `API_ID`, `API_HASH`, `BOT_TOKEN`, `TELEGRAM_STORAGE_CHAT_ID`, `TELEGRAM_WORKER_SECRET`, and `TELEGRAM_SESSION_PATH=/data/xenvo_mtproto.session` on that service. The bot must have access to that private storage chat. Configure the API service with the worker's private URL as `TELEGRAM_WORKER_URL` and the same `TELEGRAM_WORKER_SECRET`. The worker resolves and checks the storage chat before reporting ready.

The Bot API fallback is limited to `BOT_API_DOWNLOAD_MAX_BYTES` (default: under 20 MiB). Do not increase this value to bypass Telegram's hosted Bot API download limit. With the MTProto worker configured, preview ranges are fetched in aligned chunks and a bounded LRU cache is used. The native player is a backend-served page, not a separate website application. Metadata editing, durable retry jobs, configurable settings, and a formal processing queue are not implemented. No 399.58 MB, 1 GB, 2 GB, or 3 GB live Telegram playback test has been performed; Telegram source upload, bot authorization, network, proxy timeouts, worker limits, and codecs still determine actual support.

## Deployment

The API service is prepared for Railway or Docker-style deployment with:

- Fastify server runtime
- MongoDB health checks
- health endpoints
- a separate worker container at [workers/Dockerfile](workers/Dockerfile)
- persistent session path for Telethon when configured
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

This codebase keeps an operational boundary between Telegram storage and the public streaming gateway. Public media metadata does not expose raw Telegram file URLs, file IDs, MTProto access hashes, file references, or storage chat metadata. MongoDB fields are added/indexed at startup; no PostgreSQL migration exists because the repository uses MongoDB.
