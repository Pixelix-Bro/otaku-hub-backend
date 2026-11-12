import 'dotenv/config'

export interface AppConfig {
  nodeEnv: string
  port: number
  publicApiUrl: string
  publicWebUrl: string
  mongodbUri: string
  mongodbDb: string
  telegramBotToken: string
  telegramBotUsername: string
  telegramStorageChatId: string
  telegramWebhookSecret: string
  adminTelegramIds: number[]
  mediaLinkSecret: string
  botApiDownloadMaxBytes: number
  watchTokenTtlSeconds: number
  maxWatchTokenUses: number
  logLevel: string
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(`❌ Missing required environment variable: ${name}`)
  }
  return value.trim()
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.trim() !== '' ? value.trim() : fallback
}

export function loadConfig(): AppConfig {
  const telegramBotToken = requireEnv('TELEGRAM_BOT_TOKEN')
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(telegramBotToken)) {
    throw new Error('❌ TELEGRAM_BOT_TOKEN format is invalid. Expected format: 123456:ABC-DEF...')
  }

  const telegramStorageChatId = requireEnv('TELEGRAM_STORAGE_CHAT_ID')
  if (!/^-?\d+$/.test(telegramStorageChatId)) {
    throw new Error(
      '❌ TELEGRAM_STORAGE_CHAT_ID must be a numeric Telegram chat ID. Use a positive ID for a personal chat or a negative ID for a channel.'
    )
  }

  const adminIdsRaw = requireEnv('ADMIN_TELEGRAM_IDS')
  const adminTelegramIds = adminIdsRaw
    .split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id) && id > 0)

  if (adminTelegramIds.length === 0) {
    throw new Error('❌ ADMIN_TELEGRAM_IDS must contain at least one valid numeric ID.')
  }

  const botApiDownloadMaxBytes = Number(optionalEnv('BOT_API_DOWNLOAD_MAX_BYTES', '19922944'))
  if (
    !Number.isSafeInteger(botApiDownloadMaxBytes) ||
    botApiDownloadMaxBytes <= 0 ||
    botApiDownloadMaxBytes >= 20 * 1024 * 1024
  ) {
    throw new Error('❌ BOT_API_DOWNLOAD_MAX_BYTES must be a positive integer below 20 MiB.')
  }

  // Reject any banned env vars
  const banned = [
    'API_ID',
    'API_HASH',
    'TELEGRAM_API_ID',
    'TELEGRAM_API_HASH',
    'TELEGRAM_SESSION',
    'REDIS_URL',
    'S3_ENDPOINT',
    'R2_ACCOUNT_ID',
  ]
  for (const key of banned) {
    if (process.env[key]) {
      throw new Error(
        `❌ Forbidden environment variable detected: ${key}. This system uses only TELEGRAM_BOT_TOKEN.`
      )
    }
  }

  return {
    nodeEnv: optionalEnv('NODE_ENV', 'production'),
    port: Number(optionalEnv('PORT', '3000')),
    publicApiUrl: optionalEnv('PUBLIC_API_URL', '').replace(/\/+$/, ''),
    publicWebUrl: optionalEnv('PUBLIC_WEB_URL', '').replace(/\/+$/, ''),
    mongodbUri: requireEnv('MONGODB_URI'),
    mongodbDb: optionalEnv('MONGODB_DB', 'otaku_hub'),
    telegramBotToken,
    telegramBotUsername: requireEnv('TELEGRAM_BOT_USERNAME'),
    telegramStorageChatId,
    telegramWebhookSecret: requireEnv('TELEGRAM_WEBHOOK_SECRET'),
    adminTelegramIds,
    mediaLinkSecret: requireEnv('MEDIA_LINK_SECRET'),
    botApiDownloadMaxBytes,
    watchTokenTtlSeconds: Number(optionalEnv('WATCH_TOKEN_TTL_SECONDS', '604800')),
    maxWatchTokenUses: Number(optionalEnv('MAX_WATCH_TOKEN_USES', '10')),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
  }
}

let _config: AppConfig | null = null

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig()
  }
  return _config
}
