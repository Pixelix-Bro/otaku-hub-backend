import { Collection, Db, MongoClient, type Document } from 'mongodb'
import { getConfig } from '../../config/env.js'
import { DatabaseError } from '../../core/errors/app-error.js'
import { sleep } from '../../core/utils/index.js'
import { logger } from '../logger/logger.js'

let client: MongoClient | null = null
let db: Db | null = null

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000

export async function connectMongoDB(): Promise<void> {
  const config = getConfig()

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const candidate = new MongoClient(config.mongodbUri, {
      maxPoolSize: 10,
      minPoolSize: 2,
      connectTimeoutMS: 10000,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    })

    try {
      logger.info({ attempt }, '🔌 Connecting to MongoDB...')
      await candidate.connect()
      const connectedDb = candidate.db(config.mongodbDb)

      // Verify connection
      await connectedDb.command({ ping: 1 })
      client = candidate
      db = connectedDb
      logger.info({ database: config.mongodbDb }, '✅ MongoDB connected')
      return
    } catch (error) {
      logger.error({ error, attempt }, `❌ MongoDB connection attempt ${attempt} failed`)
      await candidate.close().catch(() => undefined)

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1)
        logger.info({ delay }, `⏳ Retrying in ${delay}ms...`)
        await sleep(delay)
      } else {
        throw new DatabaseError(
          `Failed to connect to MongoDB after ${MAX_RETRIES} attempts: ${(error as Error).message}`
        )
      }
    }
  }
}

export function getDb(): Db {
  if (!db) {
    throw new DatabaseError('MongoDB is not connected. Call connectMongoDB() first.')
  }
  return db
}

export function getCollection<T extends Document>(name: string): Collection<T> {
  return getDb().collection<T>(name)
}

export async function disconnectMongoDB(): Promise<void> {
  if (client) {
    try {
      await client.close()
      client = null
      db = null
      logger.info('🔌 MongoDB disconnected')
    } catch (error) {
      logger.error({ error }, '❌ Error disconnecting MongoDB')
    }
  }
}

export async function isMongoDBHealthy(): Promise<boolean> {
  try {
    if (!db) return false
    await db.command({ ping: 1 })
    return true
  } catch {
    return false
  }
}
