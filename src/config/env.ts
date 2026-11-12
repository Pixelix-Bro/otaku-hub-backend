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
  adminApiToken?: string
  mediaLinkSecret: string
  botApiDownloadMaxBytes: number
  watchTokenTtlSeconds: number
  maxWatchTokenUses: number
  logLevel: string
  telegramApiBaseUrl: string
  telegramApiId?: string
  telegramApiHash?: string
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(`❌ Missing required environment variable: ${name}`)
  }
  return value.trim()
}

function optionalEnv(name: string, fallback = ''): string {
  const value = process.env[name]
  return value && value.trim() !== '' ? value.trim() : fallback
}

function firstAvailableEnv(...names: string[]): string {
  for (const name of names) {
    const value = optionalEnv(name)
    if (value) {
      return value
    }
  }
  return ''
}

export function loadConfig(): AppConfig {
  const telegramBotToken = firstAvailableEnv('BOT_TOKEN', 'TELEGRAM_BOT_TOKEN')
  if (!telegramBotToken) {
    throw new Error('❌ Missing BOT_TOKEN or TELEGRAM_BOT_TOKEN environment variable.')
  }
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(telegramBotToken)) {
    throw new Error('❌ BOT_TOKEN format is invalid. Expected format: 123456:ABC-DEF...')
  }

  const publicApiUrl = optionalEnv('PUBLIC_API_URL', optionalEnv('PUBLIC_BASE_URL', '')).replace(
    /\/+$/,
    ''
  )
  const publicWebUrl = optionalEnv('PUBLIC_WEB_URL', '').replace(/\/+$/, '')
  const telegramApiBaseUrl = optionalEnv(
    'TELEGRAM_API_BASE_URL',
    'https://api.telegram.org'
  ).replace(/\/+$/, '')
  const telegramApiId = optionalEnv('TELEGRAM_API_ID', '')
  const telegramApiHash = optionalEnv('TELEGRAM_API_HASH', '')
  if (telegramApiBaseUrl !== 'https://api.telegram.org') {
    if (!telegramApiId || !telegramApiHash) {
      throw new Error(
        'TELEGRAM_API_ID and TELEGRAM_API_HASH are required when using the official Telegram Local Bot API server.'
      )
    }
  }
  const port = Number(optionalEnv('PORT', '3000'))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.')
  }

  const storageChatId = requireEnv('TELEGRAM_STORAGE_CHAT_ID')
  if (!/^-?\d+$/.test(storageChatId)) {
    throw new Error('❌ TELEGRAM_STORAGE_CHAT_ID must be a numeric Telegram chat ID.')
  }

  const adminIdsRaw = firstAvailableEnv('TELEGRAM_ADMIN_IDS', 'ADMIN_TELEGRAM_IDS')
  const adminTelegramIds = adminIdsRaw
    .split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id) && id > 0)

  if (adminTelegramIds.length === 0) {
    throw new Error(
      '❌ TELEGRAM_ADMIN_IDS or ADMIN_TELEGRAM_IDS must contain at least one valid numeric ID.'
    )
  }

  const botApiDownloadMaxBytes = Number(optionalEnv('BOT_API_DOWNLOAD_MAX_BYTES', '19922944'))
  if (
    !Number.isSafeInteger(botApiDownloadMaxBytes) ||
    botApiDownloadMaxBytes <= 0 ||
    botApiDownloadMaxBytes >= 20 * 1024 * 1024
  ) {
    throw new Error('❌ BOT_API_DOWNLOAD_MAX_BYTES must be a positive integer below 20 MiB.')
  }

  return {
    nodeEnv: optionalEnv('NODE_ENV', 'production'),
    port,
    publicApiUrl,
    publicWebUrl,
    mongodbUri: requireEnv('MONGODB_URI'),
    mongodbDb: optionalEnv('MONGODB_DB', 'XENVO'),
    telegramBotToken,
    telegramBotUsername: optionalEnv('TELEGRAM_BOT_USERNAME', 'xenvo_bot'),
    telegramStorageChatId: storageChatId,
    telegramWebhookSecret: requireEnv('TELEGRAM_WEBHOOK_SECRET'),
    adminTelegramIds,
    adminApiToken: optionalEnv('ADMIN_API_TOKEN', '') || undefined,
    mediaLinkSecret: requireEnv('MEDIA_LINK_SECRET'),
    botApiDownloadMaxBytes,
    watchTokenTtlSeconds: Number(optionalEnv('WATCH_TOKEN_TTL_SECONDS', '3600')),
    maxWatchTokenUses: Number(optionalEnv('MAX_WATCH_TOKEN_USES', '10')),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
    telegramApiBaseUrl,
    telegramApiId: telegramApiId || undefined,
    telegramApiHash: telegramApiHash || undefined,
  }
}

let _config: AppConfig | null = null

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig()
  }
  return _config
}
