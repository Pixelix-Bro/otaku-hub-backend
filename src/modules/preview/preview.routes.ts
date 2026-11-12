import type { FastifyInstance } from 'fastify'
import { Readable } from 'node:stream'

import { getConfig } from '../../config/env.js'
import { isMultipartRangeHeader, isValidMediaId, parseRangeHeader } from '../../core/utils/index.js'
import { getTelegramService } from '../../infrastructure/telegram/telegram.service.js'
import { getMediaById } from '../media/media.service.js'
import { WatchTokenRepository } from '../watch/watch-token.repository.js'
import { hashWatchToken, isWatchTokenExpired } from '../watch/watch-token.service.js'
import {
  buildStreamingHeaders,
  fetchWithRetry,
  readByteRange,
  shouldHonorRange,
  shouldReturnNotModified,
} from './preview.service.js'

const watchTokens = new WatchTokenRepository()
const HOSTED_BOT_API_GET_FILE_LIMIT_BYTES = 20 * 1024 * 1024

export async function previewRoutes(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'HEAD'],
    url: '/:mediaId',
    config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { mediaId } = request.params as { mediaId: string }
      const { token } = request.query as { token?: string }
      const rangeHeader =
        typeof request.headers.range === 'string' ? request.headers.range : undefined

      if (!mediaId || !isValidMediaId(mediaId)) {
        return reply.code(400).send({ ok: false, error: 'Invalid media ID' })
      }

      const config = getConfig()
      if (!token || token.length > 62 || !/^[A-Za-z0-9_-]+$/.test(token)) {
        return reply.code(401).send({ ok: false, error: 'Valid preview token required' })
      }

      const tokenHash = hashWatchToken(token)
      const tokenRecord = await watchTokens.findByHash(tokenHash)
      if (
        !tokenRecord ||
        tokenRecord.mediaId !== mediaId ||
        isWatchTokenExpired(tokenRecord.expiresAt)
      ) {
        return reply.code(403).send({ ok: false, error: 'Preview token is invalid or expired' })
      }

      const media = await getMediaById(mediaId)
      if (!media || media.storageStatus !== 'stored' || media.storageMessageId === null) {
        return reply.code(404).send({ ok: false, error: 'Stored media not found' })
      }
      if (media.sizeBytes === null || media.sizeBytes <= 0) {
        return reply.code(422).send({ ok: false, error: 'Media size is unavailable' })
      }

      const totalLength = media.sizeBytes
      const multipartRange = isMultipartRangeHeader(rangeHeader)
      const requestedRange = multipartRange ? null : parseRangeHeader(rangeHeader, totalLength)
      const fullResponseHeaders = buildStreamingHeaders({
        mediaId: media.mediaId,
        fileUniqueId: media.telegramFileUniqueId,
        fileName: media.fileName,
        mimeType: media.mimeType,
        sizeBytes: totalLength,
        updatedAt: media.updatedAt,
        range: null,
      })
      const copyResponseHeaders = (headers: Record<string, string>): void => {
        for (const [name, value] of Object.entries(headers)) {
          reply.header(name, value)
        }
      }

      const ifNoneMatch =
        typeof request.headers['if-none-match'] === 'string'
          ? request.headers['if-none-match']
          : undefined
      const ifModifiedSince =
        typeof request.headers['if-modified-since'] === 'string'
          ? request.headers['if-modified-since']
          : undefined
      if (
        shouldReturnNotModified(
          ifNoneMatch,
          ifModifiedSince,
          fullResponseHeaders.ETag!,
          media.updatedAt
        )
      ) {
        copyResponseHeaders(fullResponseHeaders)
        return reply.code(304).send()
      }

      if (rangeHeader && !requestedRange && !multipartRange) {
        reply.header('Accept-Ranges', 'bytes')
        reply.header('ETag', fullResponseHeaders.ETag!)
        reply.header('Last-Modified', fullResponseHeaders['Last-Modified']!)
        reply.header('Content-Range', `bytes */${totalLength}`)
        return reply.code(416).send({ ok: false, error: 'Invalid range request' })
      }

      const ifRange =
        typeof request.headers['if-range'] === 'string' ? request.headers['if-range'] : undefined
      const range =
        requestedRange && shouldHonorRange(ifRange, fullResponseHeaders.ETag!, media.updatedAt)
          ? requestedRange
          : null

      const selectedRange = range ?? {
        start: 0,
        end: totalLength - 1,
        length: totalLength,
        isSuffix: false,
      }

      const responseHeaders =
        range === null
          ? fullResponseHeaders
          : buildStreamingHeaders({
              mediaId: media.mediaId,
              fileUniqueId: media.telegramFileUniqueId,
              fileName: media.fileName,
              mimeType: media.mimeType,
              sizeBytes: totalLength,
              updatedAt: media.updatedAt,
              range,
            })
      const setMediaResponseHeaders = (): void => {
        copyResponseHeaders(responseHeaders)
        if (range) reply.code(206)
      }

      if (request.method === 'HEAD') {
        setMediaResponseHeaders()
        return reply.send()
      }

      try {
        const telegramService = getTelegramService()
        const mtproto = telegramService.getMtprotoFileReader()
        if (mtproto.isConfigured) {
          setMediaResponseHeaders()
          return reply.send(
            Readable.from(
              mtproto.readMessageRange({
                storageChatId: media.storageChatId,
                storageMessageId: media.storageMessageId!,
                offset: selectedRange.start,
                length: selectedRange.length,
                signal: request.signal,
              })
            )
          )
        }

        if (
          media.sizeBytes > HOSTED_BOT_API_GET_FILE_LIMIT_BYTES &&
          config.telegramApiBaseUrl === 'https://api.telegram.org'
        ) {
          return reply.code(503).send({
            ok: false,
            error:
              'Telegram hosted Bot API cannot download this file. Configure TELEGRAM_MTPROTO_API_ID and TELEGRAM_MTPROTO_API_HASH for MTProto byte-range streaming.',
          })
        }

        if (!media.telegramFileId) {
          return reply.code(404).send({ ok: false, error: 'Telegram file metadata is unavailable' })
        }
        const botApi = telegramService.getBotApiClient()
        const telegramFile = await botApi.getFile(media.telegramFileId)
        if (!telegramFile.file_path) {
          return reply.code(502).send({ ok: false, error: 'Telegram did not provide a file path' })
        }
        const upstream = await fetchWithRetry(fetch, botApi.getFileUrl(telegramFile.file_path), {
          ...(range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : {}),
          signal: request.signal,
        })
        if (!upstream.ok || !upstream.body) {
          return reply.code(502).send({ ok: false, error: 'Telegram file stream is unavailable' })
        }
        setMediaResponseHeaders()
        if (!range) {
          return reply.send(Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>))
        }

        if (upstream.status === 206) {
          const expectedContentRange = `bytes ${range.start}-${range.end}/${totalLength}`
          if (upstream.headers.get('content-range') !== expectedContentRange) {
            await upstream.body.cancel()
            return reply
              .code(502)
              .send({ ok: false, error: 'Telegram returned an invalid byte range' })
          }
          return reply.send(Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>))
        }

        return reply.send(
          Readable.from(
            readByteRange(
              upstream.body as unknown as AsyncIterable<Uint8Array>,
              selectedRange.start,
              selectedRange.length
            )
          )
        )
      } catch {
        return reply.code(502).send({ ok: false, error: 'Telegram preview request failed' })
      }
    },
  })
}
