import { getConfig } from '../../config/env.js'
import { TelegramBotApiClient } from '../../infrastructure/telegram/bot-api.client.js'
import { TelegramStorageService } from '../storage/telegram-storage.service.js'

export class TelegramBotService {
  public readonly client: TelegramBotApiClient
  public readonly storage: TelegramStorageService

  constructor() {
    const config = getConfig()
    this.client = new TelegramBotApiClient(config.telegramBotToken)
    this.storage = new TelegramStorageService(this.client, config.telegramStorageChatId)
  }

  async getBotIdentity() {
    return this.client.getMe()
  }

  async validateStorageChannel() {
    return this.storage.validateStorage()
  }

  async setupWebhook(webhookUrl: string) {
    return this.client.setWebhook(webhookUrl, {
      secret_token: getConfig().telegramWebhookSecret,
      allowed_updates: ['message'],
    })
  }
}
