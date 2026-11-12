import type { TelegramMessage } from '../../core/types/index.js'
import { getTelegramMediaMetadata, isSupportedTelegramMediaMessage } from '../media/media-id.js'

export function extractTelegramMediaMetadata(message?: TelegramMessage) {
  if (!message) {
    return null
  }

  const media = getTelegramMediaMetadata(message)
  return {
    ...media,
    mediaType: detectMessageMediaType(message),
    isMedia: isSupportedTelegramMediaMessage(message),
  }
}

export function detectMessageMediaType(message?: TelegramMessage): string | null {
  if (!message) {
    return null
  }

  return getTelegramMediaMetadata(message).mediaType ?? null
}
