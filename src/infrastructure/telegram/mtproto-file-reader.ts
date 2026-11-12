import { TelegramClient } from 'teleproto'
import { StringSession } from 'teleproto/sessions'

import type { AppConfig } from '../../config/env.js'
import { logger } from '../logger/logger.js'

export interface TelegramMessageByteRange {
  storageChatId: string
  storageMessageId: number
  offset: number
  length: number
  signal?: AbortSignal
}

export async function* takeExactBytes(
  chunks: AsyncIterable<Buffer>,
  length: number
): AsyncGenerator<Buffer> {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new RangeError('Requested byte count must be a positive safe integer.')
  }

  let remaining = length
  for await (const chunk of chunks) {
    const size = Math.min(chunk.byteLength, remaining)
    if (size > 0) {
      yield chunk.subarray(0, size)
      remaining -= size
    }
    if (remaining === 0) return
  }

  throw new Error(`Telegram range ended early; ${remaining} bytes were not received.`)
}

export class TelegramMtprotoFileReader {
  private readonly config: AppConfig
  private clientPromise: Promise<TelegramClient> | null = null
  private readonly storagePeers = new Map<string, ReturnType<TelegramClient['getInputEntity']>>()

  constructor(config: AppConfig) {
    this.config = config
  }

  get isConfigured(): boolean {
    return Boolean(this.config.telegramMtprotoApiId && this.config.telegramMtprotoApiHash)
  }

  async *readMessageRange(input: TelegramMessageByteRange): AsyncGenerator<Buffer> {
    if (!this.isConfigured) {
      throw new Error(
        'MTProto streaming is not configured: set TELEGRAM_MTPROTO_API_ID and TELEGRAM_MTPROTO_API_HASH.'
      )
    }
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(input.length) ||
      input.length <= 0
    ) {
      throw new RangeError(
        'Telegram byte range must have a non-negative offset and positive safe length.'
      )
    }

    const client = await this.getClient()
    const peer = await this.getStoragePeer(client, input.storageChatId)
    const messages = await client.getMessages(peer, { ids: input.storageMessageId })
    const message = messages[0]
    if (!message?.media) {
      throw new Error('Telegram storage message or its media was not found.')
    }

    const chunks = client.iterDownload(message, {
      offset: input.offset,
      limit: input.length,
      requestSize: this.config.telegramMtprotoRequestSizeBytes,
      signal: input.signal,
    })

    for await (const chunk of takeExactBytes(chunks, input.length)) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error('Stream aborted')
      yield chunk
    }
  }

  async disconnect(): Promise<void> {
    if (!this.clientPromise) return
    const client = await this.clientPromise.catch(() => null)
    this.clientPromise = null
    this.storagePeers.clear()
    await client?.disconnect()
  }

  private getClient(): Promise<TelegramClient> {
    if (!this.clientPromise) {
      this.clientPromise = this.createClient()
    }
    return this.clientPromise
  }

  private async createClient(): Promise<TelegramClient> {
    if (!this.config.telegramMtprotoApiId || !this.config.telegramMtprotoApiHash) {
      throw new Error('MTProto streaming is not configured.')
    }

    const client = new TelegramClient(
      new StringSession(this.config.telegramMtprotoSession ?? ''),
      this.config.telegramMtprotoApiId,
      this.config.telegramMtprotoApiHash,
      {
        connectionRetries: 5,
        maxConcurrentDownloads: this.config.telegramMtprotoMaxConcurrentDownloads,
      }
    )
    await client.start({ botAuthToken: this.config.telegramBotToken })
    if (!this.config.telegramMtprotoSession) {
      logger.warn(
        'MTProto is using an in-memory bot session; set TELEGRAM_MTPROTO_SESSION to persist auth across restarts.'
      )
    }
    return client
  }

  private getStoragePeer(
    client: TelegramClient,
    storageChatId: string
  ): Promise<Awaited<ReturnType<TelegramClient['getInputEntity']>>> {
    const cached = this.storagePeers.get(storageChatId)
    if (cached) return cached

    const peerPromise = this.resolveStoragePeer(client, storageChatId).catch((error: unknown) => {
      this.storagePeers.delete(storageChatId)
      throw error
    })
    this.storagePeers.set(storageChatId, peerPromise)
    return peerPromise
  }

  private async resolveStoragePeer(
    client: TelegramClient,
    storageChatId: string
  ): Promise<Awaited<ReturnType<TelegramClient['getInputEntity']>>> {
    try {
      return await client.getInputEntity(storageChatId)
    } catch {
      for await (const dialog of client.iterDialogs({ limit: 1000 })) {
        if (dialog.id?.toString() === storageChatId) return dialog.inputEntity
      }
      return client.getInputEntity(storageChatId)
    }
  }
}
