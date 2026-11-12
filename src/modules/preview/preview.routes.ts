import type { FastifyInstance } from 'fastify'
import { Readable } from 'node:stream'

import { getConfig } from '../../config/env.js'
import { isMultipartRangeHeader, isValidMediaId, parseRangeHeader } from '../../core/utils/index.js'
import { getTelegramService } from '../../infrastructure/telegram/telegram.service.js'
import { getMediaById } from '../media/media.service.js'
import { WatchTokenRepository } from '../watch/watch-token.repository.js'
import { hashWatchToken, isWatchTokenExpired } from '../watch/watch-token.service.js'
import { buildStreamingHeaders } from './preview.service.js'

const watchTokens = new WatchTokenRepository()

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
      const range = multipartRange ? null : parseRangeHeader(rangeHeader, totalLength)
      if (rangeHeader && !range && !multipartRange) {
        reply.header('Content-Range', `bytes */${totalLength}`)
        return reply.code(416).send({ ok: false, error: 'Invalid range request' })
      }

      const selectedRange = range ?? {
        start: 0,
        end: totalLength - 1,
        length: totalLength,
        isSuffix: false,
      }
      const workerUrlBase = config.telegramWorkerUrl
      const workerSecret = config.telegramWorkerSecret
      const useWorker = totalLength > config.botApiDownloadMaxBytes
      if (useWorker && (!workerUrlBase || !workerSecret)) {
        return reply
          .code(503)
          .send({ ok: false, error: 'Large-media streaming worker is not configured' })
      }

      const responseHeaders = buildStreamingHeaders({
        mediaId: media.mediaId,
        fileUniqueId: media.telegramFileUniqueId,
        fileName: media.fileName,
        mimeType: media.mimeType,
        sizeBytes: totalLength,
        updatedAt: media.updatedAt,
        range,
      })
      const setMediaResponseHeaders = (): void => {
        for (const [name, value] of Object.entries(responseHeaders)) {
          reply.header(name, value)
        }
        if (range) reply.code(206)
      }

      if (request.method === 'HEAD') {
        setMediaResponseHeaders()
        return reply.send()
      }

      try {
        if (useWorker) {
          if (!workerUrlBase || !workerSecret) {
            return reply
              .code(503)
              .send({ ok: false, error: 'Large-media streaming worker is not configured' })
          }
          if (!media.storageChatId || media.storageMessageId === null) {
            return reply
              .code(404)
              .send({ ok: false, error: 'Telegram storage location is unavailable' })
          }
          const workerUrl = new URL(`${workerUrlBase}/media-range`)
          workerUrl.searchParams.set('chat_id', media.storageChatId)
          workerUrl.searchParams.set('message_id', String(media.storageMessageId))
          workerUrl.searchParams.set('offset', String(selectedRange.start))
          workerUrl.searchParams.set('limit', String(selectedRange.length))
          const upstream = await fetch(workerUrl, {
            headers: { 'X-Worker-Secret': workerSecret },
            signal: request.signal,
          })
          if (!upstream.ok || !upstream.body) {
            const status = [404, 409, 416, 429, 503, 504].includes(upstream.status)
              ? upstream.status
              : 502
            const error =
              status === 404
                ? 'Telegram source message or media is unavailable'
                : status === 409
                  ? 'Telegram file reference expired and must be refreshed'
                  : status === 416
                    ? 'Telegram rejected the requested byte range'
                    : status === 429
                      ? 'Telegram rate limit reached; retry after the indicated delay'
                      : status === 503
                        ? 'MTProto worker is unavailable or at capacity'
                        : status === 504
                          ? 'Telegram media request timed out'
                          : 'MTProto worker could not fetch the requested media range'
            return reply.code(status).send({
              ok: false,
              error,
            })
          }
          setMediaResponseHeaders()
          return reply.send(Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>))
        }

        if (!media.telegramFileId) {
          return reply.code(404).send({ ok: false, error: 'Telegram file metadata is unavailable' })
        }
        const botApi = getTelegramService().getBotApiClient()
        const telegramFile = await botApi.getFile(media.telegramFileId)
        if (!telegramFile.file_path) {
          return reply.code(502).send({ ok: false, error: 'Telegram did not provide a file path' })
        }
        const upstream = await fetch(botApi.getFileUrl(telegramFile.file_path), {
          signal: request.signal,
        })
        if (!upstream.ok || !upstream.body) {
          return reply.code(502).send({ ok: false, error: 'Telegram file stream is unavailable' })
        }
        setMediaResponseHeaders()
        if (!range) {
          return reply.send(Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>))
        }
        const data = Buffer.from(await upstream.arrayBuffer())
        return reply.send(data.subarray(selectedRange.start, selectedRange.end + 1))
      } catch {
        return reply.code(502).send({ ok: false, error: 'Telegram preview request failed' })
      }
    },
  })
}
