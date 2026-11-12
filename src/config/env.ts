import 'dotenv/config';

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
  logLevel: string
  telegramApiBaseUrl: string
  telegramMtprotoApiId?: number
  telegramMtprotoApiHash?: string
  telegramMtprotoSession?: string
  telegramMtprotoMaxConcurrentDownloads: number
  telegramMtprotoRequestSizeBytes: number
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
  const telegramApiBaseUrl = (
    firstAvailableEnv('TELEGRAM_BOT_API_BASE_URL', 'TELEGRAM_API_BASE_URL') ||
    'https://api.telegram.org'
  ).replace(/\/+$/, '')
  const mtprotoApiIdRaw = firstAvailableEnv('TELEGRAM_MTPROTO_API_ID', 'TELEGRAM_API_ID', 'API_ID')
  const mtprotoApiHash = firstAvailableEnv(
    'TELEGRAM_MTPROTO_API_HASH',
    'TELEGRAM_API_HASH',
    'API_HASH'
  )
  const telegramMtprotoApiId = mtprotoApiIdRaw ? Number(mtprotoApiIdRaw) : undefined
  if ((telegramMtprotoApiId === undefined) !== !mtprotoApiHash) {
    throw new Error(
      'Both TELEGRAM_MTPROTO_API_ID and TELEGRAM_MTPROTO_API_HASH must be set together.'
    )
  }
  if (
    telegramMtprotoApiId !== undefined &&
    (!Number.isSafeInteger(telegramMtprotoApiId) || telegramMtprotoApiId <= 0)
  ) {
    throw new Error('TELEGRAM_MTPROTO_API_ID must be a positive integer.')
  }
  const telegramMtprotoMaxConcurrentDownloads = Number(
    optionalEnv('TELEGRAM_MTPROTO_MAX_CONCURRENT_DOWNLOADS', '6')
  )
  if (
    !Number.isInteger(telegramMtprotoMaxConcurrentDownloads) ||
    telegramMtprotoMaxConcurrentDownloads < 1 ||
    telegramMtprotoMaxConcurrentDownloads > 32
  ) {
    throw new Error('TELEGRAM_MTPROTO_MAX_CONCURRENT_DOWNLOADS must be between 1 and 32.')
  }
  const telegramMtprotoRequestSizeBytes = Number(
    optionalEnv('TELEGRAM_MTPROTO_REQUEST_SIZE_BYTES', String(512 * 1024))
  )
  if (
    !Number.isInteger(telegramMtprotoRequestSizeBytes) ||
    telegramMtprotoRequestSizeBytes < 4096 ||
    telegramMtprotoRequestSizeBytes > 1024 * 1024 ||
    telegramMtprotoRequestSizeBytes % 4096 !== 0
  ) {
    throw new Error(
      'TELEGRAM_MTPROTO_REQUEST_SIZE_BYTES must be a multiple of 4096 between 4096 and 1048576.'
    )
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
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
    telegramApiBaseUrl,
    ...(telegramMtprotoApiId !== undefined ? { telegramMtprotoApiId } : {}),
    ...(mtprotoApiHash ? { telegramMtprotoApiHash: mtprotoApiHash } : {}),
    ...(optionalEnv('TELEGRAM_MTPROTO_SESSION')
      ? { telegramMtprotoSession: optionalEnv('TELEGRAM_MTPROTO_SESSION') }
      : {}),
    telegramMtprotoMaxConcurrentDownloads,
    telegramMtprotoRequestSizeBytes,
  }
}

let _config: AppConfig | null = null

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig()
  }
  return _config
}
