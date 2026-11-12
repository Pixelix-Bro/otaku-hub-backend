# Telegram-Only Media Storage Backend

This project implements the Telegram-first media storage architecture described in the production specification.

## Core principles

- Official hosted Telegram Bot API only
- No MTProto, API_ID, API_HASH, or user sessions
- MongoDB stores metadata only; binary media stays in Telegram Cloud
- Media is copied server-side with `copyMessage`
- Large media is delivered through Telegram watch links rather than direct file downloads
- Railway is used for backend deployment, with health checks and environment validation

## Required environment variables

Copy [.env.example](.env.example) and fill in the real values:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `TELEGRAM_STORAGE_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `ADMIN_TELEGRAM_IDS`
- `MEDIA_LINK_SECRET`
- `MONGODB_URI`
- `PUBLIC_API_URL`
- `PUBLIC_WEB_URL`

## Local development

```bash
npm install
npm run build
npx vitest run
```

## Production deployment

The repository is set up for Railway deployment with Docker and health endpoints:

- health checks at `/health/live` and `/health/ready`
- environment validation at startup
- graceful shutdown support

## Notes

This backend scaffold is designed around the allowed Telegram-only pattern. Real bot credentials and a live storage channel are required for a complete production deployment.
