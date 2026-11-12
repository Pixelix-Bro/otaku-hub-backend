import { describe, expect, it } from 'vitest'

import { formatFileSize, parseRangeHeader } from '../../core/utils/index.js'
import { isAdminTelegramId, parseAdminTelegramIds } from '../../modules/admin/admin.service.js'
import {
  detectMediaType,
  generateMediaId,
  getMimeTypeForTelegramMessage,
  getTelegramMediaMetadata,
  isSupportedTelegramMediaMessage,
} from '../../modules/media/media-id.js'
import { buildMediaMetadataResponse } from '../../modules/media/media.service.js'
import { canPreviewPublicly } from '../../modules/preview/preview.service.js'
import { buildStoredMediaMessage } from '../../modules/telegram-bot/bot.messages.js'
import {
  createWatchTokenData,
  hashWatchToken,
  isWatchTokenExpired,
  parseWatchStartPayload,
  verifyWatchToken,
} from '../../modules/watch/watch-token.service.js'

describe('Telegram media core', () => {
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
    expect(parseRangeHeader('bytes=999999-1000000', 1_000_000)).toBeNull()
    expect(parseRangeHeader('bytes=abc', 1_000_000)).toBeNull()
  })

  it('only allows web preview when a known size fits the configured cap', () => {
    expect(canPreviewPublicly(1024, 2048)).toBe(true)
    expect(canPreviewPublicly(2049, 2048)).toBe(false)
    expect(canPreviewPublicly(null, 2048)).toBe(false)
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
      watchUrl: 'https://t.me/BOT_USERNAME?start=w_RANDOM_TOKEN',
      webPreviewUrl: 'https://api.example.com/v1/preview/MED_8F72A91C?token=WEB_PREVIEW_TOKEN',
    })

    expect(message).toContain('🎬 VIDEO MUVAFFAQIYATLI SAQLANDI!')
    expect(message).toContain('📁 Fayl nomi: anime-episode-01.mp4')
    expect(message).toContain('🆔 Media ID: MED_8F72A91C')
    expect(message).toContain('📦 Hajmi: 1.50 GB')
    expect(message).toContain('📐 Resolution: 1920 × 1080')
    expect(message).toContain(
      '🌐 Web Preview: https://api.example.com/v1/preview/MED_8F72A91C?token=WEB_PREVIEW_TOKEN'
    )
    expect(message).toContain('https://t.me/BOT_USERNAME?start=w_RANDOM_TOKEN')
  })
})
