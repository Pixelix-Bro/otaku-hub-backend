import type { FastifyInstance, FastifyRequest } from 'fastify'

import { COLLECTIONS } from '../../config/constants.js'
import { getConfig } from '../../config/env.js'
import { isValidMediaId } from '../../core/utils/index.js'
import { getDb } from '../../infrastructure/mongodb/client.js'
import { getMediaById, setMediaVisibility, softDeleteMedia } from '../media/media.service.js'

function requireAdmin(request: FastifyRequest): number | null {
  const raw = request.headers['x-telegram-user-id']
  if (typeof raw !== 'string') {
    return null
  }
  const userId = Number(raw)
  return Number.isInteger(userId) && userId > 0 ? userId : null
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stats', async (request, reply) => {
    const userId = requireAdmin(request)
    const config = getConfig()
    if (userId === null || !config.adminTelegramIds.includes(userId)) {
      return reply.code(403).send({ ok: false, error: 'Forbidden' })
    }

    const db = getDb()
    const media = db.collection(COLLECTIONS.MEDIA)
    const total = await media.countDocuments({ deletedAt: null })
    const video = await media.countDocuments({ mediaType: 'video', deletedAt: null })
    const documents = await media.countDocuments({ mediaType: 'document', deletedAt: null })
    const audio = await media.countDocuments({ mediaType: 'audio', deletedAt: null })
    const photo = await media.countDocuments({ mediaType: 'photo', deletedAt: null })

    return {
      ok: true,
      totalMedia: total,
      video,
      documents,
      audio,
      photo,
    }
  })

  app.get('/media', async (request, reply) => {
    const userId = requireAdmin(request)
    const config = getConfig()
    if (userId === null || !config.adminTelegramIds.includes(userId)) {
      return reply.code(403).send({ ok: false, error: 'Forbidden' })
    }

    const db = getDb()
    const media = db.collection(COLLECTIONS.MEDIA)
    const rows = await media.find({ deletedAt: null }).sort({ createdAt: -1 }).limit(20).toArray()
    return { ok: true, data: rows }
  })

  app.post('/media', async (request, reply) => {
    const userId = requireAdmin(request)
    const config = getConfig()
    if (userId === null || !config.adminTelegramIds.includes(userId)) {
      return reply.code(403).send({ ok: false, error: 'Forbidden' })
    }

    const body = request.body as {
      mediaType?: string
      fileName?: string
      mimeType?: string
      sizeBytes?: number
      visibility?: 'public' | 'private'
      caption?: string
    }

    if (!body.fileName) {
      return reply.code(400).send({ ok: false, error: 'fileName is required' })
    }

    const db = getDb()
    const media = db.collection(COLLECTIONS.MEDIA)
    const mediaId = `MED_${Math.random().toString(16).slice(2, 10).toUpperCase()}`
    const created = {
      mediaId,
      mediaType: body.mediaType ?? 'document',
      fileName: body.fileName,
      mimeType: body.mimeType ?? 'application/octet-stream',
      extension: body.fileName.split('.').pop()?.toLowerCase() ?? null,
      sizeBytes: body.sizeBytes ?? 0,
      telegramFileId: null,
      telegramFileUniqueId: null,
      sourceChatId: 'admin',
      sourceMessageId: 0,
      storageChatId: config.telegramStorageChatId || 'unknown',
      storageMessageId: null,
      mediaGroupId: null,
      caption: body.caption ?? null,
      durationSeconds: null,
      width: null,
      height: null,
      visibility: body.visibility ?? 'private',
      storageStatus: 'stored',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    }
    await media.insertOne(created)
    return reply.code(201).send({ ok: true, data: created })
  })

  app.patch('/media/:mediaId', async (request, reply) => {
    const userId = requireAdmin(request)
    const config = getConfig()
    if (userId === null || !config.adminTelegramIds.includes(userId)) {
      return reply.code(403).send({ ok: false, error: 'Forbidden' })
    }

    const { mediaId } = request.params as { mediaId: string }
    if (!isValidMediaId(mediaId)) {
      return reply.code(400).send({ ok: false, error: 'Invalid media ID' })
    }

    const payload = request.body as {
      visibility?: 'public' | 'private'
      caption?: string
      fileName?: string
    }
    const media = await getMediaById(mediaId)
    if (!media) {
      return reply.code(404).send({ ok: false, error: 'Media not found' })
    }

    if (payload.visibility) {
      await setMediaVisibility(mediaId, payload.visibility)
    }

    if (payload.caption !== undefined || payload.fileName !== undefined) {
      const db = getDb()
      await db.collection(COLLECTIONS.MEDIA).updateOne(
        { mediaId },
        {
          $set: {
            ...(payload.caption !== undefined ? { caption: payload.caption } : {}),
            ...(payload.fileName !== undefined ? { fileName: payload.fileName } : {}),
            updatedAt: new Date(),
          },
        }
      )
    }

    return reply.send({ ok: true, mediaId })
  })

  app.post('/media/:mediaId/publish', async (request, reply) => {
    const userId = requireAdmin(request)
    const config = getConfig()
    if (userId === null || !config.adminTelegramIds.includes(userId)) {
      return reply.code(403).send({ ok: false, error: 'Forbidden' })
    }

    const { mediaId } = request.params as { mediaId: string }
    const success = await setMediaVisibility(mediaId, 'public')
    return success
      ? reply.send({ ok: true, mediaId, visibility: 'public' })
      : reply.code(404).send({ ok: false, error: 'Media not found or not stored' })
  })

  app.post('/media/:mediaId/unpublish', async (request, reply) => {
    const userId = requireAdmin(request)
    const config = getConfig()
    if (userId === null || !config.adminTelegramIds.includes(userId)) {
      return reply.code(403).send({ ok: false, error: 'Forbidden' })
    }

    const { mediaId } = request.params as { mediaId: string }
    const success = await setMediaVisibility(mediaId, 'private')
    return success
      ? reply.send({ ok: true, mediaId, visibility: 'private' })
      : reply.code(404).send({ ok: false, error: 'Media not found or not stored' })
  })

  app.delete('/media/:mediaId', async (request, reply) => {
    const userId = requireAdmin(request)
    const config = getConfig()
    if (userId === null || !config.adminTelegramIds.includes(userId)) {
      return reply.code(403).send({ ok: false, error: 'Forbidden' })
    }

    const { mediaId } = request.params as { mediaId: string }
    const removed = await softDeleteMedia(mediaId)
    if (!removed) {
      return reply.code(404).send({ ok: false, error: 'Media not found' })
    }
    return reply.send({ ok: true, mediaId, deleted: true })
  })

  app.get('/telegram/status', async (request, reply) => {
    const userId = requireAdmin(request)
    const config = getConfig()
    if (userId === null || !config.adminTelegramIds.includes(userId)) {
      return reply.code(403).send({ ok: false, error: 'Forbidden' })
    }

    return {
      ok: true,
      botUsername: config.telegramBotUsername,
      storageChatId: config.telegramStorageChatId,
      adminIds: config.adminTelegramIds,
      webhookSecretConfigured: Boolean(config.telegramWebhookSecret),
    }
  })
}
