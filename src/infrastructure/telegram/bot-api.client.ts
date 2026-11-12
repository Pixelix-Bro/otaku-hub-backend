import { TelegramApiError } from '../../core/errors/app-error.js'
import type { TelegramApiResponse, TelegramFile, TelegramUser } from '../../core/types/index.js'
import { redactToken, sleep } from '../../core/utils/index.js'
import { logger } from '../logger/logger.js'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RETRIES = 3

export class TelegramBotApiClient {
  private readonly apiBaseUrl: string
  private readonly baseUrl: string
  private readonly token: string

  constructor(token: string, baseUrl = 'https://api.telegram.org') {
    this.token = token
    this.apiBaseUrl = baseUrl.replace(/\/+$/, '')
    this.baseUrl = `${this.apiBaseUrl}/bot${token}`
  }

  /**
   * Generic API call to Telegram Bot API with retry logic.
   */
  async callApi<T>(
    method: string,
    params?: Record<string, unknown>,
    maxRetries = MAX_RETRIES
  ): Promise<T> {
    const url = `${this.baseUrl}/${method}`
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      try {
        const controller = new AbortController()
        timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: params ? JSON.stringify(params) : '{}',
          signal: controller.signal,
        })

        const data = (await response.json()) as TelegramApiResponse<T>
        clearTimeout(timeoutId)
        timeoutId = undefined

        if (data.ok && data.result !== undefined) {
          return data.result
        }

        // Handle rate limiting (429)
        if (response.status === 429) {
          const retryAfter = data.parameters?.retry_after ?? 5
          logger.warn(
            { method, retryAfter, attempt },
            `⚠️ Telegram rate limited (429), waiting ${retryAfter}s`
          )
          await sleep(retryAfter * 1000)
          continue
        }

        // Handle server errors (5xx) — retry
        if (response.status >= 500) {
          logger.warn(
            { method, status: response.status, attempt, description: data.description },
            '⚠️ Telegram server error, retrying...'
          )
          await sleep(1000 * Math.pow(2, attempt - 1))
          continue
        }

        // Client error (4xx) — don't retry
        throw new TelegramApiError(
          `Telegram API error: ${data.description ?? 'Unknown error'}`,
          data.error_code,
          data.description
        )
      } catch (error) {
        if (timeoutId) clearTimeout(timeoutId)
        if (error instanceof TelegramApiError) throw error

        lastError = error as Error
        const isAbort = (error as Error).name === 'AbortError'

        if (isAbort) {
          logger.error({ method, attempt }, '⏱️ Telegram API request timed out')
        } else {
          logger.error(
            { method, attempt, error: (error as Error).message },
            '❌ Telegram API request failed'
          )
        }

        if (attempt < maxRetries) {
          await sleep(1000 * Math.pow(2, attempt - 1))
        }
      }
    }

    throw new TelegramApiError(
      `Telegram API call ${method} failed after ${maxRetries} attempts: ${lastError?.message ?? 'unknown error'}`
    )
  }

  /** Verify bot token with getMe */
  async getMe(): Promise<TelegramUser> {
    return this.callApi<TelegramUser>('getMe')
  }

  /** Copy a message from one chat to another (server-side, no download) */
  async copyMessage(
    chatId: number | string,
    fromChatId: number | string,
    messageId: number,
    options?: Record<string, unknown>
  ): Promise<{ message_id: number }> {
    return this.callApi<{ message_id: number }>(
      'copyMessage',
      {
        chat_id: chatId,
        from_chat_id: fromChatId,
        message_id: messageId,
        ...options,
      },
      1
    )
  }

  /** Send a text message */
  async sendMessage(
    chatId: number | string,
    text: string,
    options?: Record<string, unknown>
  ): Promise<unknown> {
    return this.callApi('sendMessage', {
      chat_id: chatId,
      text,
      ...options,
    })
  }

  async editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    options?: Record<string, unknown>
  ): Promise<unknown> {
    return this.callApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...options,
    })
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    return this.callApi<boolean>('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    })
  }

  /** Get chat member info (to check bot admin status) */
  async getChatMember(
    chatId: number | string,
    userId: number
  ): Promise<{ status: string; can_post_messages?: boolean; can_delete_messages?: boolean }> {
    return this.callApi('getChatMember', {
      chat_id: chatId,
      user_id: userId,
    })
  }

  /** Get chat info */
  async getChat(chatId: number | string): Promise<{
    id: number
    type: string
    title?: string
    username?: string
    message_auto_delete_time?: number
  }> {
    return this.callApi('getChat', { chat_id: chatId })
  }

  /** Set webhook URL */
  async setWebhook(
    url: string,
    options: { secret_token: string; allowed_updates?: string[] }
  ): Promise<boolean> {
    logger.info({ url: redactToken(url) }, '🔗 Setting webhook...')
    return this.callApi<boolean>('setWebhook', {
      url,
      secret_token: options.secret_token,
      allowed_updates: options.allowed_updates ?? ['message', 'callback_query'],
      drop_pending_updates: false,
    })
  }

  /** Delete webhook */
  async deleteWebhook(): Promise<boolean> {
    return this.callApi<boolean>('deleteWebhook', { drop_pending_updates: false })
  }

  /** Hosted Bot API downloads are limited to 20 MB; the Local Bot API supports unlimited downloads. */
  async getFile(fileId: string): Promise<TelegramFile> {
    return this.callApi<TelegramFile>('getFile', { file_id: fileId })
  }

  /** Construct download URL for a file (works with official hosted Bot API and Local Bot API server). */
  getFileUrl(filePath: string): string {
    return `${this.apiBaseUrl}/file/bot${this.token}/${filePath}`
  }

  /** Delete a message */
  async deleteMessage(chatId: number | string, messageId: number): Promise<boolean> {
    return this.callApi<boolean>('deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    })
  }

  /** Forward a message */
  async forwardMessage(
    chatId: number | string,
    fromChatId: number | string,
    messageId: number
  ): Promise<unknown> {
    return this.callApi('forwardMessage', {
      chat_id: chatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    })
  }

  /** Set bot commands */
  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<boolean> {
    return this.callApi<boolean>('setMyCommands', { commands })
  }
}
