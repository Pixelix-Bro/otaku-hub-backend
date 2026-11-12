import { logger } from '../infrastructure/logger/logger.js'
import { disconnectMongoDB } from '../infrastructure/mongodb/client.js'

export async function gracefulShutdown(): Promise<void> {
  logger.info('🛑 Shutting down gracefully...')

  try {
    await disconnectMongoDB()
    logger.info('✅ MongoDB disconnected')
  } catch (error) {
    logger.error({ error }, '❌ Failed to disconnect MongoDB')
  }
}

process.on('SIGINT', async () => {
  await gracefulShutdown()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await gracefulShutdown()
  process.exit(0)
})
