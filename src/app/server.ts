import type { FastifyInstance } from 'fastify'

import { getConfig } from '../config/env.js'
import { logger } from '../infrastructure/logger/logger.js'
import { telegramWebhookPlugin } from '../infrastructure/telegram/webhook.js'
import { adminRoutes } from '../modules/admin/admin.routes.js'
import { mediaRoutes } from '../modules/media/media.routes.js'
import { previewRoutes } from '../modules/preview/preview.routes.js'
import { processTelegramUpdate } from '../modules/telegram-bot/update.processor.js'

export async function registerServerRoutes(app: FastifyInstance): Promise<void> {
  const config = getConfig()

  app.get('/ping', async () => ({ ok: true, name: 'otaku-hub-backend' }))

  app.register(mediaRoutes, { prefix: '/v1/media' })
  app.register(adminRoutes, { prefix: '/v1/admin' })
  app.register(previewRoutes, { prefix: '/v1/preview' })

  await app.register(telegramWebhookPlugin, {
    onUpdate: async (update) => {
      logger.info({ updateId: update.update_id }, '🪝 webhook update received')
      await processTelegramUpdate(update)
    },
  })

  app.get('/v1', async () => ({
    ok: true,
    service: 'telegram-media-storage',
    apiVersion: 'v1',
    publicApiUrl: config.publicApiUrl || config.publicWebUrl || 'http://localhost:3000',
  }))
}
