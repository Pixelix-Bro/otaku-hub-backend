import { COLLECTIONS } from '../../config/constants.js'
import { formatFileSize, isValidMediaId } from '../../core/utils/index.js'
import { getDb } from '../../infrastructure/mongodb/client.js'
import { generateMediaId } from './media-id.js'

export interface MediaDocumentLike {
  mediaId: string
  mediaType: string
  fileName: string | null
  mimeType: string | null
  extension: string | null
  sizeBytes: number | null
  telegramFileId: string | null
  telegramFileUniqueId: string | null
  mtprotoDocumentId?: string | null
  mtprotoAccessHash?: string | null
  mtprotoDcId?: number | null
  mtprotoFileReference?: string | null
  mtprotoStatus?: 'unconfigured' | 'available' | 'unavailable'
  sourceChatId: string
  sourceMessageId: number
  storageChatId: string
  storageMessageId: number | null
  mediaGroupId: string | null
  caption: string | null
  durationSeconds: number | null
  width: number | null
  height: number | null
  visibility: string
  storageStatus: string
  createdAt: Date
  updatedAt: Date
  deletedAt?: Date | null
}

export async function listMedia(
  page = 1,
  limit = 20,
  visibility?: string
): Promise<MediaDocumentLike[]> {
  const db = getDb()
  const collection = db.collection(COLLECTIONS.MEDIA)
  const safePage = Math.max(1, Number(page) || 1)
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100)
  const filter = { deletedAt: null, ...(visibility ? { visibility } : {}) }
  const rows = await collection
    .find(filter)
    .sort({ createdAt: -1 })
    .skip((safePage - 1) * safeLimit)
    .limit(safeLimit)
    .toArray()
  return rows as unknown as MediaDocumentLike[]
}

export async function getMediaById(mediaId: string): Promise<MediaDocumentLike | null> {
  if (!isValidMediaId(mediaId)) return null
  const db = getDb()
  const collection = db.collection(COLLECTIONS.MEDIA)
  const row = await collection.findOne({ mediaId, deletedAt: null })
  return row as MediaDocumentLike | null
}

export async function getMediaBySourceMessage(
  sourceChatId: string,
  sourceMessageId: number
): Promise<MediaDocumentLike | null> {
  const row = await getDb().collection(COLLECTIONS.MEDIA).findOne({ sourceChatId, sourceMessageId })
  return row as MediaDocumentLike | null
}

export async function setMediaVisibility(
  mediaId: string,
  visibility: 'public' | 'private'
): Promise<boolean> {
  const result = await getDb()
    .collection(COLLECTIONS.MEDIA)
    .updateOne(
      { mediaId, deletedAt: null, storageStatus: 'stored' },
      { $set: { visibility, updatedAt: new Date() } }
    )
  return result.modifiedCount === 1
}

export async function createMediaRecord(
  input: Partial<MediaDocumentLike> & { mediaType?: string }
): Promise<MediaDocumentLike> {
  const mediaId = input.mediaId ?? generateMediaId()
  const now = new Date()
  const record = {
    mediaId,
    mediaType: input.mediaType ?? 'document',
    fileName: input.fileName ?? null,
    mimeType: input.mimeType ?? null,
    extension: input.extension ?? null,
    sizeBytes: input.sizeBytes ?? null,
    telegramFileId: input.telegramFileId ?? null,
    telegramFileUniqueId: input.telegramFileUniqueId ?? null,
    mtprotoDocumentId: input.mtprotoDocumentId ?? null,
    mtprotoAccessHash: input.mtprotoAccessHash ?? null,
    mtprotoDcId: input.mtprotoDcId ?? null,
    mtprotoFileReference: input.mtprotoFileReference ?? null,
    mtprotoStatus: input.mtprotoStatus ?? 'unconfigured',
    sourceChatId: input.sourceChatId ?? 'unknown',
    sourceMessageId: input.sourceMessageId ?? 0,
    storageChatId: input.storageChatId ?? 'unknown',
    storageMessageId: input.storageMessageId ?? null,
    mediaGroupId: input.mediaGroupId ?? null,
    caption: input.caption ?? null,
    durationSeconds: input.durationSeconds ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
    visibility: input.visibility ?? 'private',
    storageStatus: input.storageStatus ?? 'pending',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }

  const db = getDb()
  await db.collection(COLLECTIONS.MEDIA).insertOne(record)
  return record as MediaDocumentLike
}

export async function updateMediaStorage(
  mediaId: string,
  input: {
    storageStatus: string
    storageMessageId?: number | null
    sizeBytes?: number
    mtprotoDocumentId?: string | null
    mtprotoAccessHash?: string | null
    mtprotoDcId?: number | null
    mtprotoFileReference?: string | null
    mtprotoStatus?: 'unconfigured' | 'available' | 'unavailable'
  }
): Promise<boolean> {
  const result = await getDb()
    .collection(COLLECTIONS.MEDIA)
    .updateOne(
      { mediaId, deletedAt: null },
      {
        $set: {
          storageStatus: input.storageStatus,
          ...(input.storageMessageId !== undefined
            ? { storageMessageId: input.storageMessageId }
            : {}),
          ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
          ...(input.mtprotoDocumentId !== undefined
            ? { mtprotoDocumentId: input.mtprotoDocumentId }
            : {}),
          ...(input.mtprotoAccessHash !== undefined
            ? { mtprotoAccessHash: input.mtprotoAccessHash }
            : {}),
          ...(input.mtprotoDcId !== undefined ? { mtprotoDcId: input.mtprotoDcId } : {}),
          ...(input.mtprotoFileReference !== undefined
            ? { mtprotoFileReference: input.mtprotoFileReference }
            : {}),
          ...(input.mtprotoStatus !== undefined ? { mtprotoStatus: input.mtprotoStatus } : {}),
          updatedAt: new Date(),
        },
      }
    )
  return result.modifiedCount === 1
}

export async function softDeleteMedia(mediaId: string): Promise<MediaDocumentLike | null> {
  const media = await getMediaById(mediaId)
  if (!media) return null
  const now = new Date()
  await getDb()
    .collection(COLLECTIONS.MEDIA)
    .updateOne(
      { mediaId, deletedAt: null },
      { $set: { deletedAt: now, updatedAt: now, storageStatus: 'deleted' } }
    )
  return media
}

export function buildMediaMetadataResponse(record: MediaDocumentLike): Record<string, unknown> {
  return {
    mediaId: record.mediaId,
    mediaType: record.mediaType,
    fileName: record.fileName,
    mimeType: record.mimeType,
    extension: record.extension,
    sizeBytes: record.sizeBytes,
    formattedSize: record.sizeBytes == null ? null : formatFileSize(record.sizeBytes),
    caption: record.caption,
    durationSeconds: record.durationSeconds,
    width: record.width,
    height: record.height,
    visibility: record.visibility,
    status: record.storageStatus,
    telegramWatchUrl: null,
    webPreviewUrl: null,
    createdAt: record.createdAt.toISOString(),
  }
}
