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
  telegramSessionPath?: string
  telegramWorkerUrl?: string
  telegramWorkerSecret?: string
  streamChunkBytes: number
  maxActiveStreams: number
  maxPartsPerMedia: number
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

  const telegramWorkerUrlRaw = optionalEnv('TELEGRAM_WORKER_URL')
  const telegramWorkerSecretRaw = optionalEnv('TELEGRAM_WORKER_SECRET')
  const workerValues = [telegramWorkerUrlRaw, telegramWorkerSecretRaw]
  const workerConfiguredCount = workerValues.filter(Boolean).length
  if (workerConfiguredCount !== 0 && workerConfiguredCount !== workerValues.length) {
    throw new Error(
      'Configure TELEGRAM_WORKER_URL and TELEGRAM_WORKER_SECRET together to enable MTProto streaming.'
    )
  }

  const telegramWorkerUrl = telegramWorkerUrlRaw.replace(/\/+$/, '') || undefined
  if (telegramWorkerUrl) {
    let parsedWorkerUrl: URL
    try {
      parsedWorkerUrl = new URL(telegramWorkerUrl)
    } catch {
      throw new Error('TELEGRAM_WORKER_URL must be an absolute HTTP(S) URL.')
    }
    if (parsedWorkerUrl.protocol !== 'http:' && parsedWorkerUrl.protocol !== 'https:') {
      throw new Error('TELEGRAM_WORKER_URL must use HTTP or HTTPS.')
    }
  }
  const telegramWorkerSecret = telegramWorkerSecretRaw || undefined

  const streamChunkBytes = Number(optionalEnv('STREAM_CHUNK_BYTES', '524288'))
  const maxActiveStreams = Number(optionalEnv('MAX_ACTIVE_STREAMS', '10'))
  const maxPartsPerMedia = Number(optionalEnv('MAX_PARTS_PER_MEDIA', '1000'))
  if (
    !Number.isSafeInteger(streamChunkBytes) ||
    streamChunkBytes < 4096 ||
    streamChunkBytes > 524288 ||
    streamChunkBytes % 4096 !== 0
  ) {
    throw new Error('STREAM_CHUNK_BYTES must be a 4 KiB multiple between 4096 and 524288.')
  }

  return {
    nodeEnv: optionalEnv('NODE_ENV', 'production'),
    port: Number(optionalEnv('PORT', '3000')),
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
    telegramSessionPath: optionalEnv('TELEGRAM_SESSION_PATH', '/data/xenvo_mtproto.session'),
    telegramWorkerUrl,
    telegramWorkerSecret,
    streamChunkBytes,
    maxActiveStreams:
      Number.isFinite(maxActiveStreams) && maxActiveStreams > 0 ? maxActiveStreams : 10,
    maxPartsPerMedia:
      Number.isFinite(maxPartsPerMedia) && maxPartsPerMedia > 0 ? maxPartsPerMedia : 1000,
  }
}

let _config: AppConfig | null = null

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig()
  }
  return _config
}
