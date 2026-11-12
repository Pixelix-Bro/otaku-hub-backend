import { randomBytes } from 'node:crypto'

import { COLLECTIONS } from '../../config/constants.js'
import { getCollection } from '../../infrastructure/mongodb/client.js'

interface AdminActionRecord {
  token: string
  action: 'delete_media'
  mediaId: string
  adminTelegramId: number
  expiresAt: Date
  usedAt: Date | null
  createdAt: Date
}

export async function createDeleteConfirmation(
  mediaId: string,
  adminTelegramId: number,
  ttlSeconds = 300
): Promise<string> {
  const token = randomBytes(16).toString('base64url')
  const now = new Date()
  await getCollection<AdminActionRecord>(COLLECTIONS.BOT_ACTIONS).insertOne({
    token,
    action: 'delete_media',
    mediaId,
    adminTelegramId,
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    usedAt: null,
    createdAt: now,
  })
  return token
}

export async function consumeDeleteConfirmation(
  token: string,
  adminTelegramId: number,
  now = new Date()
): Promise<string | null> {
  const collection = getCollection<AdminActionRecord>(COLLECTIONS.BOT_ACTIONS)
  const result = await collection.updateOne(
    {
      token,
      action: 'delete_media',
      adminTelegramId,
      usedAt: null,
      expiresAt: { $gt: now },
    },
    { $set: { usedAt: now } }
  )
  if (result.modifiedCount !== 1) return null
  const record = await collection.findOne({ token, adminTelegramId, usedAt: now })
  return record?.mediaId ?? null
}
