import type { FastifyInstance } from 'fastify'
import { Readable } from 'node:stream'

import { getConfig } from '../../config/env.js'
import { isValidMediaId } from '../../core/utils/index.js'
import { getTelegramService } from '../../infrastructure/telegram/telegram.service.js'
import { getMediaById } from '../media/media.service.js'
import { WatchTokenRepository } from '../watch/watch-token.repository.js'
import { hashWatchToken, isWatchTokenUsable } from '../watch/watch-token.service.js'

const watchTokens = new WatchTokenRepository()

export async function previewRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:mediaId', async (request, reply) => {
    const { mediaId } = request.params as { mediaId: string }
    const { token } = request.query as { token?: string }

    if (!mediaId || !isValidMediaId(mediaId)) {
      return reply.code(400).send({ ok: false, error: 'Invalid media ID' })
    }

    const config = getConfig()
    if (!token || token.length > 62 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      return reply.code(401).send({ ok: false, error: 'Valid preview token required' })
    }

    const tokenHash = hashWatchToken(token)
    const tokenRecord = await watchTokens.findByHash(tokenHash)
    if (!tokenRecord || tokenRecord.mediaId !== mediaId || !isWatchTokenUsable(tokenRecord)) {
      return reply.code(403).send({ ok: false, error: 'Preview token is invalid or expired' })
    }

    const media = await getMediaById(mediaId)
    if (!media || media.storageStatus !== 'stored' || media.storageMessageId === null) {
      return reply.code(404).send({ ok: false, error: 'Stored media not found' })
    }
    if (media.visibility !== 'public') {
      return reply
        .code(403)
        .send({ ok: false, error: 'Web preview is not available for private media' })
    }
    if (media.sizeBytes === null || media.sizeBytes > config.botApiDownloadMaxBytes) {
      return reply
        .code(413)
        .send({ ok: false, error: 'Media exceeds the configured preview limit' })
    }

    const claimedToken = await watchTokens.consumeIfUsable(tokenHash)
    if (!claimedToken) {
      return reply
        .code(403)
        .send({ ok: false, error: 'Preview token has expired or reached its use limit' })
    }

    try {
      const botApi = getTelegramService().getBotApiClient()
      if (!media.telegramFileId) {
        return reply.code(404).send({ ok: false, error: 'Telegram file metadata is unavailable' })
      }

      const telegramFile = await botApi.getFile(media.telegramFileId)
      if (!telegramFile.file_path) {
        return reply.code(502).send({ ok: false, error: 'Telegram did not provide a file path' })
      }
      if (
        telegramFile.file_size !== undefined &&
        telegramFile.file_size > config.botApiDownloadMaxBytes
      ) {
        return reply
          .code(413)
          .send({ ok: false, error: 'Telegram file exceeds the configured preview limit' })
      }

      const upstream = await fetch(botApi.getFileUrl(telegramFile.file_path))
      if (!upstream.ok || !upstream.body) {
        return reply.code(502).send({ ok: false, error: 'Telegram file stream is unavailable' })
      }

      const contentType = media.mimeType ?? upstream.headers.get('content-type')
      reply.header(
        'Content-Type',
        contentType && /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(contentType)
          ? contentType
          : 'application/octet-stream'
      )
      reply.header('Cache-Control', 'private, no-store')
      reply.header('Referrer-Policy', 'no-referrer')
      const contentLength = telegramFile.file_size ?? media.sizeBytes
      if (contentLength !== null) reply.header('Content-Length', String(contentLength))
      return reply.send(Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>))
    } catch {
      return reply.code(502).send({ ok: false, error: 'Telegram preview request failed' })
    }
  })
}
