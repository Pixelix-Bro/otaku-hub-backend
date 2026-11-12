import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import Fastify from 'fastify'

import { getConfig } from '../config/env.js'
import { logger } from '../infrastructure/logger/logger.js'
import { connectMongoDB, isMongoDBHealthy } from '../infrastructure/mongodb/client.js'
import { createAllIndexes } from '../infrastructure/mongodb/indexes.js'
import { getTelegramService } from '../infrastructure/telegram/telegram.service.js'
import { registerServerRoutes } from './server.js'

let startupReady = false

export async function bootstrap(): Promise<ReturnType<typeof Fastify>> {
  const config = getConfig()

  const app = Fastify({
    logger: false,
    trustProxy: true,
  })

  await app.register(helmet, {
    global: true,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })

  await app.register(cors, {
    origin: config.publicWebUrl
      ? [config.publicWebUrl]
      : config.nodeEnv === 'development'
        ? /^https?:\/\/localhost(?::\d+)?$/
        : false,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Range'],
    exposedHeaders: [
      'Accept-Ranges',
      'Content-Disposition',
      'Content-Length',
      'Content-Range',
      'ETag',
    ],
  })

  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    skipOnError: true,
  })

  await registerServerRoutes(app)

  app.get('/health/live', async () => ({ ok: true, status: 'live' }))
  app.get('/health/ready', async (_, reply) => {
    const mongoHealthy = await isMongoDBHealthy()
    const botHealthy = await getTelegramService()
      .getBotApiClient()
      .getMe()
      .then(() => true)
      .catch(() => false)
    const ready = startupReady && mongoHealthy && botHealthy
    return reply.code(ready ? 200 : 503).send({
      ok: ready,
      status: ready ? 'ready' : 'not_ready',
      mongo: mongoHealthy,
      telegramBot: botHealthy,
    })
  })
  app.get('/health', async (_, reply) => {
    const mongoHealthy = await isMongoDBHealthy()
    const botHealthy = await getTelegramService()
      .getBotApiClient()
      .getMe()
      .then(() => true)
      .catch(() => false)
    const ready = startupReady && mongoHealthy && botHealthy
    return reply.code(ready ? 200 : 503).send({
      ok: ready,
      status: ready ? 'ok' : 'degraded',
      mongo: mongoHealthy,
      telegramBot: botHealthy,
      env: config.nodeEnv,
    })
  })

  return app
}

export async function initializeBackend(): Promise<void> {
  const config = getConfig()
  startupReady = false

  try {
    await connectMongoDB()
    await createAllIndexes()
    logger.info('✅ MongoDB schema ready')

    const telegramService = getTelegramService()
    await telegramService.initialize()
    logger.info('✅ Telegram bot verified and storage channel validated')
    startupReady = true
  } catch (error) {
    startupReady = false
    logger.error(
      { error },
      '❌ Startup validation failed: bot token, storage channel, or MongoDB issue'
    )
    throw error
  }
}
