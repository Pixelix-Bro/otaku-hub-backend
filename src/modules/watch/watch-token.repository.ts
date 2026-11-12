import { COLLECTIONS } from '../../config/constants.js'
import { getCollection } from '../../infrastructure/mongodb/client.js'

export interface WatchTokenRecord {
  tokenHash: string
  mediaId: string
  expiresAt?: Date
  maxUses?: number
  usedCount: number
  createdAt: Date
}

export class WatchTokenRepository {
  async create(record: WatchTokenRecord): Promise<WatchTokenRecord> {
    const collection = getCollection<WatchTokenRecord>(COLLECTIONS.WATCH_TOKENS)
    await collection.insertOne({ ...record, usedCount: record.usedCount ?? 0 })
    return record
  }

  async findByHash(tokenHash: string): Promise<WatchTokenRecord | undefined> {
    const collection = getCollection<WatchTokenRecord>(COLLECTIONS.WATCH_TOKENS)
    return (await collection.findOne({ tokenHash })) ?? undefined
  }

  async findByMediaId(mediaId: string): Promise<WatchTokenRecord | undefined> {
    const collection = getCollection<WatchTokenRecord>(COLLECTIONS.WATCH_TOKENS)
    return (await collection.findOne({ mediaId })) ?? undefined
  }
}
