import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getConfig } from '../../config/env.js'
import type { TelegramUpdate } from '../../core/types/index.js'
import { constantTimeCompare } from '../../core/utils/index.js'
import { logger } from '../logger/logger.js'

interface WebhookPluginOptions {
  onUpdate: (update: TelegramUpdate) => Promise<void>
}

export async function telegramWebhookPlugin(
  fastify: FastifyInstance,
  options: WebhookPluginOptions
): Promise<void> {
  const config = getConfig()

  fastify.post(
    '/v1/telegram/webhook',
    {
      config: { rateLimit: { max: 1000, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // 1. Verify webhook secret
      const secretHeader = request.headers['x-telegram-bot-api-secret-token'] as string | undefined

      if (!secretHeader || !constantTimeCompare(secretHeader, config.telegramWebhookSecret)) {
        logger.warn('⚠️ Invalid webhook secret token')
        return reply.code(401).send({ error: 'Unauthorized' })
      }

      const update = request.body as TelegramUpdate

      if (!update || typeof update.update_id !== 'number') {
        logger.warn('⚠️ Invalid update payload')
        return reply.code(400).send({ error: 'Invalid update' })
      }

      try {
        await options.onUpdate(update)
        return reply.code(200).send({ ok: true })
      } catch (error) {
        logger.error({ error, updateId: update.update_id }, '❌ Error processing webhook update')
        return reply.code(500).send({ ok: false, error: 'Update processing failed' })
      }
    }
  )

  logger.info('🔗 Telegram webhook route registered at POST /v1/telegram/webhook')
}
