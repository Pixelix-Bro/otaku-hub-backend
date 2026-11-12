import type { FastifyInstance } from 'fastify'

import { COLLECTIONS } from '../../config/constants.js'
import { getConfig } from '../../config/env.js'
import { getDb } from '../../infrastructure/mongodb/client.js'

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stats', async () => {
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

  app.get('/media', async () => {
    const db = getDb()
    const media = db.collection(COLLECTIONS.MEDIA)
    const rows = await media.find({ deletedAt: null }).sort({ createdAt: -1 }).limit(20).toArray()
    return { ok: true, data: rows }
  })

  app.get('/telegram/status', async () => {
    const config = getConfig()
    return {
      ok: true,
      botUsername: config.telegramBotUsername,
      storageChatId: config.telegramStorageChatId,
      adminIds: config.adminTelegramIds,
      webhookSecretConfigured: Boolean(config.telegramWebhookSecret),
    }
  })
}
