import { getConfig } from '../../config/env.js'
import type { TelegramUser } from '../../core/types/index.js'
import { logger } from '../logger/logger.js'
import { TelegramBotApiClient } from './bot-api.client.js'
import { StorageChannelService } from './storage-channel.js'

export class TelegramService {
  private readonly botApiClient: TelegramBotApiClient
  private readonly storageChannel: StorageChannelService
  private botInfo: TelegramUser | null = null

  constructor() {
    const config = getConfig()
    this.botApiClient = new TelegramBotApiClient(config.telegramBotToken)
    this.storageChannel = new StorageChannelService(this.botApiClient, config.telegramStorageChatId)
  }

  /**
   * Initialize: verify bot token, validate storage channel, set webhook.
   */
  async initialize(): Promise<void> {
    const config = getConfig()

    // 1. Verify bot token
    logger.info('🤖 Verifying bot token...')
    this.botInfo = await this.botApiClient.getMe()
    logger.info(
      { id: this.botInfo.id, username: this.botInfo.username, name: this.botInfo.first_name },
      '✅ Bot token verified'
    )

    // 2. Validate storage channel
    await this.storageChannel.validate()

    // Telegram only accepts public HTTPS webhook URLs.
    if (config.publicApiUrl) {
      let webhookBase: URL
      try {
        webhookBase = new URL(config.publicApiUrl)
      } catch {
        throw new Error('PUBLIC_API_URL must be an absolute HTTPS URL for Telegram webhooks.')
      }

      if (webhookBase.protocol !== 'https:') {
        if (config.nodeEnv === 'development') {
          logger.warn(
            '⚠️ Skipping Telegram webhook registration in development: use a public HTTPS tunnel to receive bot updates.'
          )
        } else {
          throw new Error(
            'PUBLIC_API_URL must use HTTPS in production. Telegram Bot API does not accept HTTP or localhost webhooks.'
          )
        }
      } else {
        const webhookUrl = `${config.publicApiUrl}/v1/telegram/webhook`
        await this.botApiClient.setWebhook(webhookUrl, {
          secret_token: config.telegramWebhookSecret,
          allowed_updates: ['message', 'callback_query'],
        })
        logger.info('✅ Webhook set successfully')
      }
    } else {
      logger.warn('⚠️ PUBLIC_API_URL not set; Telegram webhook is not configured.')
    }

    // 4. Set bot commands
    await this.botApiClient.setMyCommands([
      { command: 'start', description: 'Botni ishga tushirish' },
      { command: 'help', description: 'Yordam' },
      { command: 'stats', description: 'Statistika' },
      { command: 'list', description: 'Oxirgi media fayllar' },
      { command: 'get', description: 'Media olish (ID bilan)' },
      { command: 'preview', description: 'XENVO web watch link yaratish' },
      { command: 'search', description: 'Qidirish' },
      { command: 'visibility', description: 'Media visibility o‘zgartirish' },
      { command: 'delete', description: "Media o'chirish" },
      { command: 'status', description: 'Bot holati' },
      { command: 'reconcile', description: 'Storage tekshiruvi' },
    ])
  }

  getBotApiClient(): TelegramBotApiClient {
    return this.botApiClient
  }

  getStorageChannel(): StorageChannelService {
    return this.storageChannel
  }

  getBotInfo(): TelegramUser {
    if (!this.botInfo) {
      throw new Error('Bot not initialized. Call initialize() first.')
    }
    return this.botInfo
  }

  async shutdown(): Promise<void> {
    try {
      await this.botApiClient.deleteWebhook()
      logger.info('🔌 Webhook deleted')
    } catch (error) {
      logger.warn({ error }, '⚠️ Failed to delete webhook during shutdown')
    }
  }
}

let telegramService: TelegramService | null = null

export function getTelegramService(): TelegramService {
  if (!telegramService) {
    telegramService = new TelegramService()
  }
  return telegramService
}
