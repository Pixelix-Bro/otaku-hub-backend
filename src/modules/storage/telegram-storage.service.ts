import { StorageError, TelegramApiError } from '../../core/errors/app-error.js'
import { TelegramBotApiClient } from '../../infrastructure/telegram/bot-api.client.js'

export class TelegramStorageService {
  constructor(
    private readonly botApiClient: TelegramBotApiClient,
    private readonly storageChatId: string
  ) {}

  async validateStorage(): Promise<{ ok: true; storageChatId: string }> {
    const bot = await this.botApiClient.getMe()
    const chat = await this.botApiClient.getChat(this.storageChatId)
    const member = await this.botApiClient.getChatMember(this.storageChatId, bot.id)

    if (chat.type !== 'channel' && chat.type !== 'supergroup') {
      throw new StorageError(
        `Storage chat must be a private channel or supergroup. Received: ${chat.type}`
      )
    }

    if (member.status !== 'administrator' && member.status !== 'creator') {
      throw new StorageError(
        `Bot must be administrator in storage chat. Current status: ${member.status}`
      )
    }

    if (member.can_post_messages === false) {
      throw new StorageError('Bot lacks permission to post media to the storage chat.')
    }

    return { ok: true, storageChatId: this.storageChatId }
  }

  async copyMessageToStorage(
    fromChatId: number | string,
    messageId: number
  ): Promise<{ storageMessageId: number }> {
    try {
      const result = await this.botApiClient.copyMessage(this.storageChatId, fromChatId, messageId)
      return { storageMessageId: result.message_id }
    } catch (error) {
      if (error instanceof TelegramApiError) {
        throw new StorageError(`Failed to copy media to Telegram storage: ${error.message}`)
      }
      throw new StorageError(
        `Failed to copy media to Telegram storage: ${(error as Error).message}`
      )
    }
  }
}
