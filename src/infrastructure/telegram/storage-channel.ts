import { StorageError, TelegramApiError } from '../../core/errors/app-error.js'
import { logger } from '../logger/logger.js'
import { TelegramBotApiClient } from './bot-api.client.js'

export class StorageChannelService {
  private readonly botApiClient: TelegramBotApiClient
  private readonly storageChatId: string

  constructor(botApiClient: TelegramBotApiClient, storageChatId: string) {
    this.botApiClient = botApiClient
    this.storageChatId = storageChatId
  }

  /**
   * Validate that the storage channel exists and bot has proper admin permissions.
   */
  async validate(): Promise<void> {
    logger.info({ storageChatId: this.storageChatId }, '🔍 Validating storage channel...')

    // 1. Check channel exists
    let chat: {
      id: number
      type: string
      title?: string
      username?: string
      message_auto_delete_time?: number
    }
    try {
      chat = await this.botApiClient.getChat(this.storageChatId)
    } catch (error) {
      throw new StorageError(
        `Storage channel ${this.storageChatId} not found or bot has no access. ` +
          `Ensure the channel exists and the bot is added to it.`
      )
    }

    if (chat.type !== 'channel') {
      throw new StorageError(`Storage chat must be a private channel. Got: ${chat.type}`)
    }
    if (chat.username) {
      throw new StorageError('Storage channel must be private and must not have a public username.')
    }
    if (chat.message_auto_delete_time) {
      throw new StorageError('Automatic message deletion must be disabled in the storage channel.')
    }

    logger.info({ chatId: chat.id, title: chat.title, type: chat.type }, '✅ Storage channel found')

    // 2. Check bot is admin
    const botInfo = await this.botApiClient.getMe()
    let member: { status: string; can_post_messages?: boolean; can_delete_messages?: boolean }
    try {
      member = await this.botApiClient.getChatMember(this.storageChatId, botInfo.id)
    } catch (error) {
      throw new StorageError(
        `Cannot check bot membership in storage channel. ` +
          `Make sure the bot is an administrator.`
      )
    }

    if (member.status !== 'administrator' && member.status !== 'creator') {
      throw new StorageError(
        `Bot must be an administrator in the storage channel. ` + `Current status: ${member.status}`
      )
    }

    if (member.can_post_messages === false) {
      throw new StorageError('Bot lacks permission to post messages in the storage channel.')
    }

    logger.info(
      {
        status: member.status,
        canPost: member.can_post_messages,
        canDelete: member.can_delete_messages,
      },
      '✅ Bot is admin in storage channel'
    )
  }

  /**
   * Copy a media message from source chat to storage channel.
   * Uses copyMessage — no download, server-side copy.
   */
  async copyMediaToStorage(
    fromChatId: number | string,
    messageId: number
  ): Promise<{ storageMessageId: number }> {
    try {
      const result = await this.botApiClient.copyMessage(this.storageChatId, fromChatId, messageId)

      logger.info(
        { fromChatId, messageId, storageMessageId: result.message_id },
        '✅ Media copied to storage channel'
      )

      return { storageMessageId: result.message_id }
    } catch (error) {
      if (error instanceof TelegramApiError) {
        throw new StorageError(
          `Failed to copy media to storage: ${error.telegramDescription ?? error.message}`
        )
      }
      throw new StorageError(`Failed to copy media to storage: ${(error as Error).message}`)
    }
  }

  /**
   * Copy a media message from storage channel to user's chat.
   * Uses copyMessage — no download, server-side copy.
   */
  async copyMediaToUser(
    storageMessageId: number,
    userChatId: number | string
  ): Promise<{ messageId: number }> {
    try {
      const result = await this.botApiClient.copyMessage(
        userChatId,
        this.storageChatId,
        storageMessageId
      )

      logger.info(
        { storageMessageId, userChatId, sentMessageId: result.message_id },
        '✅ Media copied to user chat'
      )

      return { messageId: result.message_id }
    } catch (error) {
      if (error instanceof TelegramApiError) {
        throw new StorageError(
          `Failed to deliver media to user: ${error.telegramDescription ?? error.message}`
        )
      }
      throw new StorageError(`Failed to deliver media to user: ${(error as Error).message}`)
    }
  }

  /**
   * Delete a message from storage channel.
   */
  async deleteStorageMessage(storageMessageId: number): Promise<boolean> {
    try {
      return await this.botApiClient.deleteMessage(this.storageChatId, storageMessageId)
    } catch (error) {
      logger.error({ error, storageMessageId }, '❌ Failed to delete storage message')
      return false
    }
  }

  getStorageChatId(): string {
    return this.storageChatId
  }
}
