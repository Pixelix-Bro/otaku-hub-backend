import type { FastifyInstance } from 'fastify'

import { logger } from '../infrastructure/logger/logger.js'
import { disconnectMongoDB } from '../infrastructure/mongodb/client.js'
import { getTelegramService } from '../infrastructure/telegram/telegram.service.js'

export async function gracefulShutdown(server?: FastifyInstance): Promise<void> {
  logger.info('🛑 Shutting down gracefully...')

  try {
    await server?.close()
    logger.info('✅ HTTP server closed')
  } catch (error) {
    logger.error({ error }, '❌ Failed to close HTTP server')
  }

  try {
    await getTelegramService().disconnectMtproto()
  } catch (error) {
    logger.error({ error }, '❌ Failed to disconnect Telegram MTProto client')
  }

  try {
    await disconnectMongoDB()
    logger.info('✅ MongoDB disconnected')
  } catch (error) {
    logger.error({ error }, '❌ Failed to disconnect MongoDB')
  }
}

export function registerShutdownHandlers(getServer: () => FastifyInstance | undefined): void {
  let shutdownStarted = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownStarted) return
    shutdownStarted = true
    logger.info({ signal }, '🛑 Shutdown signal received')
    await gracefulShutdown(getServer())
  }

  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}
