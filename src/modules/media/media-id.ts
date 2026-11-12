import { randomBytes } from 'node:crypto'

import {
  AUDIO_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MEDIA_TYPES,
  VIDEO_EXTENSIONS,
  type MediaType,
} from '../../config/constants.js'
import type { TelegramMessage } from '../../core/types/index.js'

export function generateMediaId(): string {
  return `MED_${randomBytes(4).toString('hex').toUpperCase()}`
}

export function detectMediaType(message: Partial<TelegramMessage>): MediaType | null {
  if (message.video) return MEDIA_TYPES.VIDEO
  if (message.document) return MEDIA_TYPES.DOCUMENT
  if (message.audio) return MEDIA_TYPES.AUDIO
  if (message.photo && message.photo.length > 0) return MEDIA_TYPES.PHOTO
  if (message.animation) return MEDIA_TYPES.ANIMATION
  if (message.voice) return MEDIA_TYPES.VOICE
  if (message.video_note) return MEDIA_TYPES.VIDEO_NOTE
  if (message.sticker) return MEDIA_TYPES.STICKER
  return null
}

export function isSupportedTelegramMediaMessage(message: Partial<TelegramMessage>): boolean {
  if (!message) return false

  const type = detectMediaType(message)
  if (!type) return false

  const fileName =
    message.document?.file_name ??
    message.video?.file_name ??
    message.audio?.file_name ??
    message.animation?.file_name ??
    message.sticker?.file_id ??
    null

  const mimeType = getMimeTypeForTelegramMessage(message)
  const hasFileId = Boolean(
    message.document?.file_id ??
    message.video?.file_id ??
    message.audio?.file_id ??
    message.animation?.file_id ??
    message.voice?.file_id ??
    message.video_note?.file_id ??
    message.sticker?.file_id ??
    message.photo?.[0]?.file_id
  )

  return hasFileId && (Boolean(fileName) || Boolean(mimeType) || type !== null)
}

export function getMimeTypeForTelegramMessage(message: Partial<TelegramMessage>): string | null {
  const document = message.document
  if (document?.mime_type) {
    return document.mime_type
  }

  if (message.video?.mime_type) {
    return message.video.mime_type
  }

  if (message.audio?.mime_type) {
    return message.audio.mime_type
  }

  if (message.document?.file_name) {
    const fileName = message.document.file_name.toLowerCase()
    if (fileName.endsWith('.pdf')) return 'application/pdf'
    if (fileName.endsWith('.txt')) return 'text/plain'
    if (fileName.endsWith('.zip')) return 'application/zip'
    if (fileName.endsWith('.mp3')) return 'audio/mpeg'
    if (fileName.endsWith('.png')) return 'image/png'
    if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) return 'image/jpeg'
  }

  return null
}

export function detectMediaFileExtension(
  fileName: string | null | undefined,
  mimeType: string | null
): string | null {
  const safe = (fileName ?? '').trim()
  if (safe && safe.includes('.')) {
    const extension = safe.split('.').pop()?.toLowerCase()
    if (extension) return extension
  }

  if (!mimeType) return null

  const lookup: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'video/x-msvideo': 'avi',
    'video/webm': 'webm',
    'video/mpeg': 'mpeg',
    'audio/mpeg': 'mp3',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
    'audio/flac': 'flac',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/tiff': 'tiff',
    'image/bmp': 'bmp',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/x-rar-compressed': 'rar',
    'text/plain': 'txt',
  }

  return lookup[mimeType] ?? null
}

export function inferMediaTypeFromExtension(fileName: string | null | undefined): MediaType | null {
  const extension = (fileName ?? '').split('.').pop()?.toLowerCase() ?? ''

  if (VIDEO_EXTENSIONS.has(extension)) return MEDIA_TYPES.VIDEO
  if (DOCUMENT_EXTENSIONS.has(extension)) return MEDIA_TYPES.DOCUMENT
  if (AUDIO_EXTENSIONS.has(extension)) return MEDIA_TYPES.AUDIO
  if (IMAGE_EXTENSIONS.has(extension)) return MEDIA_TYPES.PHOTO

  return null
}

export function getTelegramMediaMetadata(message: TelegramMessage) {
  const largestPhoto = message.photo?.[message.photo.length - 1]
  const type =
    detectMediaType(message) ??
    inferMediaTypeFromExtension(
      message.document?.file_name ??
        message.audio?.file_name ??
        message.video?.file_name ??
        message.animation?.file_name ??
        null
    ) ??
    MEDIA_TYPES.DOCUMENT

  return {
    mediaId: generateMediaId(),
    mediaType: type,
    fileName:
      message.document?.file_name ??
      message.audio?.file_name ??
      message.video?.file_name ??
      message.animation?.file_name ??
      null,
    mimeType: getMimeTypeForTelegramMessage(message),
    extension: detectMediaFileExtension(
      message.document?.file_name ??
        message.audio?.file_name ??
        message.video?.file_name ??
        message.animation?.file_name ??
        null,
      getMimeTypeForTelegramMessage(message)
    ),
    sizeBytes:
      message.document?.file_size ??
      message.video?.file_size ??
      message.audio?.file_size ??
      message.animation?.file_size ??
      message.voice?.file_size ??
      message.sticker?.file_size ??
      largestPhoto?.file_size ??
      null,
    telegramFileId:
      message.document?.file_id ??
      message.video?.file_id ??
      message.audio?.file_id ??
      message.animation?.file_id ??
      message.voice?.file_id ??
      message.video_note?.file_id ??
      message.sticker?.file_id ??
      largestPhoto?.file_id ??
      null,
    telegramFileUniqueId:
      message.document?.file_unique_id ??
      message.video?.file_unique_id ??
      message.audio?.file_unique_id ??
      message.animation?.file_unique_id ??
      message.voice?.file_unique_id ??
      message.video_note?.file_unique_id ??
      message.sticker?.file_unique_id ??
      largestPhoto?.file_unique_id ??
      null,
    durationSeconds:
      message.video?.duration ??
      message.audio?.duration ??
      message.animation?.duration ??
      message.voice?.duration ??
      message.video_note?.duration ??
      null,
    width:
      message.video?.width ??
      message.animation?.width ??
      message.sticker?.width ??
      largestPhoto?.width ??
      null,
    height:
      message.video?.height ??
      message.animation?.height ??
      message.sticker?.height ??
      largestPhoto?.height ??
      null,
    mediaGroupId: message.media_group_id ?? null,
    caption: message.caption ?? null,
  }
}
