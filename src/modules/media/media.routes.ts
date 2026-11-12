import type { FastifyInstance } from 'fastify'

import { COLLECTIONS } from '../../config/constants.js'
import { getConfig } from '../../config/env.js'
import { isValidMediaId } from '../../core/utils/index.js'
import { getDb } from '../../infrastructure/mongodb/client.js'
import { buildWatchPageUrl, canPreviewMedia } from '../preview/preview.service.js'
import { WatchTokenRepository } from '../watch/watch-token.repository.js'
import { createWatchTokenData } from '../watch/watch-token.service.js'
import { buildMediaMetadataResponse, getMediaById, listMedia } from './media.service.js'

const watchTokens = new WatchTokenRepository()

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) => {
    const query = request.query as { page?: string; limit?: string }
    const page = Number(query.page ?? 1)
    const limit = Number(query.limit ?? 20)
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      return reply
        .code(400)
        .send({ ok: false, error: 'page must be >= 1 and limit must be between 1 and 100' })
    }
    const rows = await listMedia(page, limit, 'public')
    const total = await getDb()
      .collection(COLLECTIONS.MEDIA)
      .countDocuments({ deletedAt: null, visibility: 'public' })
    return {
      ok: true,
      data: rows.map((item) => buildMediaMetadataResponse(item)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }
  })

  app.get('/metadata', async (request, reply) => {
    const query = request.query as { page?: string; limit?: string }
    const page = Number(query.page ?? 1)
    const limit = Number(query.limit ?? 20)
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      return reply
        .code(400)
        .send({ ok: false, error: 'page must be >= 1 and limit must be between 1 and 100' })
    }
    const rows = await listMedia(page, limit, 'public')
    const total = await getDb()
      .collection(COLLECTIONS.MEDIA)
      .countDocuments({ deletedAt: null, visibility: 'public' })
    return {
      ok: true,
      data: rows.map((item) => buildMediaMetadataResponse(item)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }
  })

  app.get('/:mediaId/metadata', async (request, reply) => {
    const { mediaId } = request.params as { mediaId: string }

    if (!isValidMediaId(mediaId)) {
      return reply.code(400).send({ ok: false, error: 'Invalid media ID' })
    }

    const item = await getMediaById(mediaId)
    if (!item || item.visibility !== 'public') {
      return reply.code(404).send({ ok: false, error: 'Media not found' })
    }

    return { ok: true, data: buildMediaMetadataResponse(item) }
  })

  app.post('/:mediaId/watch-token', async (request, reply) => {
    const config = getConfig()
    const { mediaId } = request.params as { mediaId: string }

    if (!isValidMediaId(mediaId)) {
      return reply.code(400).send({ ok: false, error: 'Invalid media ID' })
    }

    const media = await getMediaById(mediaId)
    if (!media || media.storageStatus !== 'stored' || media.storageMessageId === null) {
      return reply.code(404).send({ ok: false, error: 'Stored media not found' })
    }
    if (media.visibility !== 'public') {
      return reply.code(403).send({ ok: false, error: 'Media is not public' })
    }

    const token = createWatchTokenData({
      mediaId,
      expiresAt: new Date(Date.now() + config.watchTokenTtlSeconds * 1000),
      maxUses: config.maxWatchTokenUses,
    })
    await watchTokens.create({ ...token, usedCount: 0 })

    const publicBaseUrl = config.publicApiUrl
    const workerReady = Boolean(
      config.telegramWorkerUrl &&
      config.telegramWorkerSecret &&
      config.mtprotoApiId &&
      config.mtprotoApiHash &&
      media.mtprotoStatus === 'available'
    )
    const previewUrl =
      publicBaseUrl && canPreviewMedia(media.sizeBytes, config.botApiDownloadMaxBytes, workerReady)
        ? buildWatchPageUrl(publicBaseUrl, mediaId, token.token)
        : null

    return reply.code(200).send({
      ok: true,
      mediaId,
      token: token.token,
      previewUrl,
      expiresAt: token.expiresAt.toISOString(),
    })
  })

  app.get('/:mediaId/watch-link', async (request, reply) => {
    const config = getConfig()
    const { mediaId } = request.params as { mediaId: string }

    if (!isValidMediaId(mediaId)) {
      return reply.code(400).send({ ok: false, error: 'Invalid media ID' })
    }

    const media = await getMediaById(mediaId)
    if (!media || media.storageStatus !== 'stored' || media.storageMessageId === null) {
      return reply.code(404).send({ ok: false, error: 'Stored media not found' })
    }
    if (media.visibility !== 'public') {
      return reply.code(404).send({ ok: false, error: 'Media not found' })
    }

    const token = createWatchTokenData({
      mediaId,
      expiresAt: new Date(Date.now() + config.watchTokenTtlSeconds * 1000),
      maxUses: config.maxWatchTokenUses,
    })
    await watchTokens.create({ ...token, usedCount: 0 })

    const workerReady = Boolean(
      config.telegramWorkerUrl &&
      config.telegramWorkerSecret &&
      config.mtprotoApiId &&
      config.mtprotoApiHash &&
      media.mtprotoStatus === 'available'
    )
    const basePreviewUrl =
      media.visibility === 'public' &&
      canPreviewMedia(media.sizeBytes, config.botApiDownloadMaxBytes, workerReady)
        ? buildWatchPageUrl(config.publicApiUrl || config.publicWebUrl, mediaId, token.token)
        : null

    return reply.code(200).send({
      ok: true,
      mediaId,
      webPreviewUrl: basePreviewUrl,
    })
  })

  app.get('/:mediaId/preview', async (request, reply) => {
    const { mediaId } = request.params as { mediaId: string }
    const { token } = request.query as { token?: string }
    if (!isValidMediaId(mediaId)) {
      return reply.code(400).send({ ok: false, error: 'Invalid media ID' })
    }
    if (!token) return reply.code(401).send({ ok: false, error: 'Preview token required' })
    return reply.code(307).redirect(`/v1/preview/${mediaId}?token=${encodeURIComponent(token)}`)
  })

  app.get('/:mediaId/stream', async (request, reply) => {
    const { mediaId } = request.params as { mediaId: string }
    const { token } = request.query as { token?: string }
    if (!token) return reply.code(401).send({ ok: false, error: 'Watch token required' })
    return reply.code(307).redirect(`/api/stream/${mediaId}?token=${encodeURIComponent(token)}`)
  })

  app.delete('/:mediaId', async (request, reply) => {
    const { mediaId } = request.params as { mediaId: string }
    if (!isValidMediaId(mediaId)) {
      return reply.code(400).send({ ok: false, error: 'Invalid media ID' })
    }

    return reply.code(501).send({
      ok: false,
      mediaId,
      error: 'HTTP deletion is disabled; use the authenticated Telegram bot confirmation flow.',
    })
  })
}
