# XENVO Media Backend

This repository implements the XENVO server-side media architecture with Telegram-first storage, HTTP range streaming, and secure watch links. It remains compatible with the existing Fastify + MongoDB setup while adding the XENVO contract used for production-grade media streaming.

## Core principles

- Telegram Bot API is used for bot webhooks and bot admin flow.
- MTProto credentials are allowed for the dedicated worker and range-based file retrieval.
- MongoDB stores metadata, message IDs, admin records, and token state.
- Binary media remains in Telegram cloud storage and is not copied into a hidden storage channel.
- The public API exposes watch-token-protected media access, not raw Telegram file links.
- Streaming uses HTTP range semantics and 206 partial responses.

## Environment contract

Copy [.env.example](.env.example) and replace the placeholders with real values.

Required variables include:

- `BOT_TOKEN`
- `API_ID`
- `API_HASH`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_ADMIN_IDS`
- `MONGODB_URI`
- `MONGODB_DB`
- `MEDIA_LINK_SECRET`
- `PUBLIC_BASE_URL`
- `WATCH_TOKEN_TTL_SECONDS`
- `MAX_WATCH_TOKEN_USES`
- `STREAM_CHUNK_BYTES`

Legacy keys remain accepted for backward compatibility, including `TELEGRAM_BOT_TOKEN` and `ADMIN_TELEGRAM_IDS`.

## Local development

```bash
npm install
npm run build
npm test
```

## Runtime behavior

The app exposes:

- Health checks at `/health/live` and `/health/ready`
- Public watch metadata routes under `/api/media` and `/v1/media`
- Range-aware preview streaming under `/api/stream/:mediaId` and `/v1/preview/:mediaId`
- Telegram bot webhook setup and admin validation hooks

## MTProto worker

A proof-of-concept worker is available under [workers/mtproto_worker.py](workers/mtproto_worker.py). It uses Telethon with bot auth and can serve byte-range fetches via the `client.iter_download` flow for Telegram media objects.

Install the worker dependencies:

```bash
cd workers
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Deployment

The repository is prepared for Railway or Docker-style deployment with:

- Fastify server runtime
- MongoDB health checks
- health endpoints
- persistent session path for Telethon when configured
- Dockerfile for the API service

## Notes

This codebase intentionally keeps an operational boundary between Telegram storage and the public streaming gateway. The backend never exposes raw Telegram file URLs, file IDs, or storage chat metadata to the public API.
