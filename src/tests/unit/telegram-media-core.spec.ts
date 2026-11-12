import { describe, expect, it } from 'vitest'

import { loadConfig } from '../../config/env.js'
import { formatFileSize, isMultipartRangeHeader, parseRangeHeader } from '../../core/utils/index.js'
import { takeExactBytes } from '../../infrastructure/telegram/mtproto-file-reader.js'
import {
  isAdminTelegramId,
  isValidAdminApiToken,
  parseAdminTelegramIds,
} from '../../modules/admin/admin.service.js'
import {
  detectMediaType,
  generateMediaId,
  getMimeTypeForTelegramMessage,
  getTelegramMediaMetadata,
  isSupportedTelegramMediaMessage,
} from '../../modules/media/media-id.js'
import { buildMediaMetadataResponse } from '../../modules/media/media.service.js'
import {
  buildStreamingHeaders,
  buildWatchPageUrl,
  canPreviewMedia,
  canPreviewPublicly,
  fetchWithRetry,
  readByteRange,
  shouldHonorRange,
  shouldReturnNotModified,
} from '../../modules/preview/preview.service.js'
import { callbackData, escapeHtml } from '../../modules/telegram-bot/bot.dashboard.js'
import { buildStoredMediaMessage } from '../../modules/telegram-bot/bot.messages.js'
import {
  createWatchTokenData,
  hashWatchToken,
  isWatchTokenExpired,
  isWatchTokenUsable,
  parseWatchStartPayload,
  verifyWatchToken,
} from '../../modules/watch/watch-token.service.js'

describe('Telegram media core', () => {
  it('configures a Local Bot API URL without requiring its server credentials in the backend', () => {
    const env = {
      NODE_ENV: 'production',
      BOT_TOKEN: '123456:ABCDEF_token',
      TELEGRAM_STORAGE_CHAT_ID: '-1001234567890',
      TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
      TELEGRAM_ADMIN_IDS: '123456789',
      MONGODB_URI: 'mongodb://localhost:27017',
      MONGODB_DB: 'XENVO',
      MEDIA_LINK_SECRET: 'media-link-secret',
      TELEGRAM_BOT_API_BASE_URL: 'http://telegram-bot-api:8081/',
    }
    const keys = [...Object.keys(env), 'TELEGRAM_API_BASE_URL']
    const originalValues = new Map(keys.map((key) => [key, process.env[key]]))
    Object.assign(process.env, env)
    delete process.env.TELEGRAM_API_BASE_URL

    try {
      const config = loadConfig()
      expect(config.telegramApiBaseUrl).toBe('http://telegram-bot-api:8081')

      delete process.env.TELEGRAM_BOT_API_BASE_URL
      process.env.TELEGRAM_API_BASE_URL = 'http://legacy-telegram-bot-api:8081'
      expect(loadConfig().telegramApiBaseUrl).toBe('http://legacy-telegram-bot-api:8081')
    } finally {
      for (const [key, value] of originalValues) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('creates media IDs in the required MED_XXXXXXXX format', () => {
    const mediaId = generateMediaId()
    expect(mediaId).toMatch(/^MED_[0-9A-F]{8}$/)
  })

  it('detects media types and mime types from Telegram message payloads', () => {
    expect(
      detectMediaType({
        video: { file_id: '1', file_unique_id: 'u', width: 1, height: 1, duration: 1 },
      })
    ).toBe('video')
    expect(
      getMimeTypeForTelegramMessage({
        document: { file_id: '1', file_unique_id: 'u', file_name: 'test.pdf' },
      })
    ).toBe('application/pdf')
    expect(
      detectMediaType({ photo: [{ file_id: '1', file_unique_id: 'u', width: 1, height: 1 }] })
    ).toBe('photo')
    expect(
      isSupportedTelegramMediaMessage({
        document: { file_id: '1', file_unique_id: 'u', file_name: 'test.pdf' },
      })
    ).toBe(true)
    const photoMetadata = getTelegramMediaMetadata({
      message_id: 1,
      chat: { id: 1, type: 'private' },
      date: 1,
      photo: [
        { file_id: 'small', file_unique_id: 'small-u', width: 10, height: 10, file_size: 100 },
        { file_id: 'large', file_unique_id: 'large-u', width: 20, height: 20, file_size: 200 },
      ],
    })
    expect(photoMetadata.telegramFileId).toBe('large')
    expect(photoMetadata.sizeBytes).toBe(200)
    expect(photoMetadata.width).toBe(20)
  })

  it('validates admin Telegram IDs from configuration', () => {
    expect(isAdminTelegramId(123456789, [123456789, 987654321])).toBe(true)
    expect(isAdminTelegramId(111, [123456789, 987654321])).toBe(false)
    expect(parseAdminTelegramIds('123,456,789')).toEqual([123, 456, 789])
  })

  it('requires a bearer token for HTTP admin authorization', () => {
    expect(isValidAdminApiToken('Bearer secure-admin-token', 'secure-admin-token')).toBe(true)
    expect(isValidAdminApiToken('Bearer wrong-token', 'secure-admin-token')).toBe(false)
    expect(isValidAdminApiToken('secure-admin-token', 'secure-admin-token')).toBe(false)
    expect(isValidAdminApiToken('Bearer secure-admin-token', undefined)).toBe(false)
  })

  it('validates callback_data by UTF-8 bytes and escapes dynamic HTML', () => {
    expect(callbackData('a'.repeat(64))).toBe('a'.repeat(64))
    expect(() => callbackData('é'.repeat(33))).toThrow(/64 bytes/)
    expect(escapeHtml(`<x a="'">&`)).toBe('&lt;x a=&quot;&#39;&quot;&gt;&amp;')
  })

  it('formats file sizes using the 1024-based rule', () => {
    expect(formatFileSize(1024)).toBe('1.00 KB')
    expect(formatFileSize(1536)).toBe('1.50 KB')
    expect(formatFileSize(0)).toBe('0 B')
  })

  it('hashes and expires watch tokens securely', () => {
    const token = 'watch_token_example'
    const hash = hashWatchToken(token)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)

    const createdAt = new Date(Date.now() - 60_000)
    const tokenData = createWatchTokenData({
      mediaId: 'MED_12345678',
      expiresAt: new Date(Date.now() + 600_000),
      maxUses: 10,
      createdAt,
    })
    expect(tokenData.tokenHash).toBeTruthy()
    expect(verifyWatchToken(tokenData.token, tokenData.tokenHash)).toBe(true)
    expect(isWatchTokenExpired(tokenData.expiresAt)).toBe(false)
    expect(tokenData.token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Buffer.from(tokenData.token, 'base64url').length).toBeGreaterThanOrEqual(32)
    expect(parseWatchStartPayload(`w_${tokenData.token}`)).toBe(tokenData.token)
    expect(parseWatchStartPayload(`w_${tokenData.token}!`)).toBeNull()
    expect(parseWatchStartPayload(`w_${'a'.repeat(63)}`)).toBeNull()
  })

  it('creates reusable watch tokens without an expiration or usage limit', () => {
    const tokenData = createWatchTokenData({ mediaId: 'MED_12345678' })
    expect(tokenData.expiresAt).toBeUndefined()
    expect(tokenData.maxUses).toBeUndefined()
    expect(isWatchTokenExpired(tokenData.expiresAt)).toBe(false)
    expect(isWatchTokenUsable({ usedCount: 1000, ...tokenData })).toBe(true)
  })

  it('parses valid HTTP range requests and rejects invalid ones', () => {
    expect(parseRangeHeader('bytes=0-1048575', 10 * 1024 * 1024)).toEqual({
      start: 0,
      end: 1048575,
      length: 1048576,
      isSuffix: false,
    })
    expect(parseRangeHeader('bytes=10485760-20971519', 50 * 1024 * 1024)).toEqual({
      start: 10485760,
      end: 20971519,
      length: 10485760,
      isSuffix: false,
    })
    expect(parseRangeHeader('bytes=-512000', 1_000_000)).toEqual({
      start: 488000,
      end: 999999,
      length: 512000,
      isSuffix: true,
    })
    expect(parseRangeHeader('bytes=-2000000', 1_000_000)).toEqual({
      start: 0,
      end: 999999,
      length: 1_000_000,
      isSuffix: true,
    })
    expect(parseRangeHeader('bytes=999999-1000000', 1_000_000)).toEqual({
      start: 999999,
      end: 999999,
      length: 1,
      isSuffix: false,
    })
    expect(parseRangeHeader('bytes=1000000-', 1_000_000)).toBeNull()
    expect(parseRangeHeader('bytes=abc', 1_000_000)).toBeNull()
    expect(parseRangeHeader('bytes=4294967296-4294967395', 10 * 1024 ** 3)).toEqual({
      start: 4294967296,
      end: 4294967395,
      length: 100,
      isSuffix: false,
    })
    expect(isMultipartRangeHeader('bytes=0-10,20-30')).toBe(true)
    expect(isMultipartRangeHeader('bytes=0-10')).toBe(false)
    expect(isMultipartRangeHeader('items=0-10,20-30')).toBe(false)
  })

  it('streams a requested byte range without buffering the complete upstream media', async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('0123')
      yield Buffer.from('4567')
      yield Buffer.from('89')
    }

    const result: Uint8Array[] = []
    for await (const chunk of readByteRange(chunks(), 3, 5)) {
      result.push(chunk)
    }

    expect(Buffer.concat(result).toString()).toBe('34567')
  })

  it('limits MTProto chunks to the requested byte count and rejects truncated reads', async () => {
    async function* chunks(): AsyncGenerator<Buffer> {
      yield Buffer.from('abcd')
      yield Buffer.from('efgh')
    }

    const output: Buffer[] = []
    for await (const chunk of takeExactBytes(chunks(), 6)) output.push(chunk)
    expect(Buffer.concat(output).toString()).toBe('abcdef')

    async function* shortChunks(): AsyncGenerator<Buffer> {
      yield Buffer.from('abc')
    }
    await expect(async () => {
      for await (const _chunk of takeExactBytes(shortChunks(), 4)) {
      }
    }).rejects.toThrow(/ended early/)
  })

  it('accepts bot-auth MTProto credentials only as a complete API ID/hash pair', () => {
    const env = {
      NODE_ENV: 'production',
      BOT_TOKEN: '123456:ABCDEF_token',
      TELEGRAM_STORAGE_CHAT_ID: '-1001234567890',
      TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
      TELEGRAM_ADMIN_IDS: '123456789',
      MONGODB_URI: 'mongodb://localhost:27017',
      MEDIA_LINK_SECRET: 'media-link-secret',
      TELEGRAM_MTPROTO_API_ID: '12345678',
      TELEGRAM_MTPROTO_API_HASH: 'mtproto-api-hash',
      TELEGRAM_MTPROTO_SESSION: 'opaque-session-secret',
    }
    const keys = [...Object.keys(env), 'API_ID', 'API_HASH']
    const originalValues = new Map(keys.map((key) => [key, process.env[key]]))
    Object.assign(process.env, env)

    try {
      const config = loadConfig()
      expect(config.telegramMtprotoApiId).toBe(12345678)
      expect(config.telegramMtprotoApiHash).toBe('mtproto-api-hash')
      expect(config.telegramMtprotoSession).toBe('opaque-session-secret')

      delete process.env.TELEGRAM_MTPROTO_API_HASH
      expect(() => loadConfig()).toThrow(/must be set together/)
    } finally {
      for (const [key, value] of originalValues) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('honors HTTP range validators and retries transient stream setup failures', async () => {
    const updatedAt = new Date('2026-01-02T03:04:05.000Z')
    const etag = '"stable-etag"'
    expect(shouldHonorRange(etag, etag, updatedAt)).toBe(true)
    expect(shouldHonorRange('W/"stable-etag"', etag, updatedAt)).toBe(false)
    expect(shouldHonorRange('"stale-etag"', etag, updatedAt)).toBe(false)
    expect(shouldHonorRange(updatedAt.toUTCString(), etag, updatedAt)).toBe(true)
    expect(shouldReturnNotModified(`W/${etag}`, undefined, etag, updatedAt)).toBe(true)
    expect(shouldReturnNotModified(undefined, updatedAt.toUTCString(), etag, updatedAt)).toBe(true)

    let attempts = 0
    const response = await fetchWithRetry(
      async () => {
        attempts += 1
        if (attempts === 1) throw new Error('temporary connection failure')
        return new Response('ok')
      },
      'https://media.example/video',
      {}
    )

    expect(attempts).toBe(2)
    expect(await response.text()).toBe('ok')
  })

  it('allows large previews when the Local Bot API server is configured', () => {
    expect(canPreviewPublicly(1024, 2048)).toBe(true)
    expect(canPreviewPublicly(2049, 2048)).toBe(false)
    expect(canPreviewPublicly(null, 2048)).toBe(false)
  })

  it('allows preview links for large media without an application size cap', () => {
    expect(canPreviewMedia(null)).toBe(false)
    expect(canPreviewMedia(0)).toBe(false)
    for (const megabytes of [19, 20, 21, 100, 500, 1024, 2048, 4096, 10240]) {
      expect(canPreviewMedia(megabytes * 1024 * 1024)).toBe(true)
    }
  })

  it('builds the canonical backend watch-page URL with an encoded bearer token', () => {
    expect(buildWatchPageUrl('https://api.example.com/', 'MED_12345678', 'token_abc')).toBe(
      'https://api.example.com/watch/MED_12345678?token=token_abc'
    )
    expect(buildWatchPageUrl('', 'MED_12345678', 'token_abc')).toBeNull()
  })

  it('builds exact range response headers and sanitizes unsafe metadata', () => {
    const headers = buildStreamingHeaders({
      mediaId: 'MED_12345678',
      fileUniqueId: 'unique-file',
      fileName: 'episode 01.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10_000_000,
      updatedAt: new Date(0),
      range: { start: 1048576, end: 2097151, length: 1048576, isSuffix: false },
    })

    expect(headers['Accept-Ranges']).toBe('bytes')
    expect(headers['Content-Length']).toBe('1048576')
    expect(headers['Content-Range']).toBe('bytes 1048576-2097151/10000000')
    expect(headers['Content-Type']).toBe('video/mp4')
    expect(headers['Content-Disposition']).toContain('inline;')
    expect(headers['ETag']).toMatch(/^"[A-Za-z0-9_-]+"$/)

    const unsafe = buildStreamingHeaders({
      mediaId: 'MED_12345678',
      fileUniqueId: null,
      fileName: 'clip.mp4\r\nX-Injected: yes',
      mimeType: 'video/mp4\r\nX-Injected: yes',
      sizeBytes: 100,
      updatedAt: new Date(0),
      range: null,
    })
    expect(unsafe['Content-Type']).toBe('application/octet-stream')
    expect(unsafe['Content-Disposition']).not.toContain('\r')
    expect(unsafe['Content-Disposition']).not.toContain('\n')

    const largeHeaders = buildStreamingHeaders({
      mediaId: 'MED_12345678',
      fileUniqueId: 'large-file',
      fileName: 'large-video.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10 * 1024 ** 3,
      updatedAt: new Date(0),
      range: {
        start: 4 * 1024 ** 3,
        end: 4 * 1024 ** 3 + 1023,
        length: 1024,
        isSuffix: false,
      },
    })
    expect(largeHeaders['Content-Length']).toBe('1024')
    expect(largeHeaders['Content-Range']).toBe('bytes 4294967296-4294968319/10737418240')
  })

  it('does not expose Telegram or storage identifiers in public metadata', () => {
    const metadata = buildMediaMetadataResponse({
      mediaId: 'MED_12345678',
      mediaType: 'video',
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      extension: 'mp4',
      sizeBytes: 1024,
      telegramFileId: 'secret-file-id',
      telegramFileUniqueId: 'secret-unique-id',
      sourceChatId: '123',
      sourceMessageId: 1,
      storageChatId: '-1001',
      storageMessageId: 2,
      mediaGroupId: null,
      caption: null,
      durationSeconds: 1,
      width: 10,
      height: 10,
      visibility: 'public',
      storageStatus: 'stored',
      createdAt: new Date(0),
      updatedAt: new Date(0),
      deletedAt: null,
    })

    expect(metadata).not.toHaveProperty('telegramFileId')
    expect(metadata).not.toHaveProperty('telegramFileUniqueId')
    expect(metadata).not.toHaveProperty('storageChatId')
    expect(metadata).not.toHaveProperty('storageMessageId')
  })

  it('builds the required Telegram success message for stored media', () => {
    const message = buildStoredMediaMessage({
      mediaType: 'video',
      fileName: 'anime-episode-01.mp4',
      mediaId: 'MED_8F72A91C',
      sizeLabel: '1.50 GB',
      mimeType: 'video/mp4',
      formatLabel: 'MP4',
      durationLabel: '24:18',
      resolutionLabel: '1920 × 1080',
      webPreviewUrl: 'https://api.example.com/watch/MED_8F72A91C?token=WEB_PREVIEW_TOKEN',
    })

    expect(message).toContain('🎬 VIDEO XENVO STREAMING’GA TAYYOR!')
    expect(message).toContain('📁 Fayl nomi: anime-episode-01.mp4')
    expect(message).toContain('🆔 Media ID: MED_8F72A91C')
    expect(message).toContain('📦 Hajmi: 1.50 GB')
    expect(message).toContain('📐 Resolution: 1920 × 1080')
    expect(message).toContain(
      '🔗 XENVO’da tomosha qilish: https://api.example.com/watch/MED_8F72A91C?token=WEB_PREVIEW_TOKEN'
    )
    expect(message).not.toContain('https://t.me/')
  })
})
