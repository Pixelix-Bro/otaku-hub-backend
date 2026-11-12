import { createHash } from 'node:crypto'

import type { ParsedRangeHeader } from '../../core/utils/index.js'
import { sanitizeFilename } from '../../core/utils/index.js'

export function buildPreviewUrl(publicBaseUrl: string, mediaId: string): string | null {
  if (!publicBaseUrl) return null
  return `${publicBaseUrl.replace(/\/+$/, '')}/v1/preview/${mediaId}`
}

export function buildWatchPageUrl(
  publicBaseUrl: string,
  mediaId: string,
  token: string
): string | null {
  if (!publicBaseUrl) return null
  return `${publicBaseUrl.replace(/\/+$/, '')}/watch/${encodeURIComponent(mediaId)}?token=${encodeURIComponent(token)}`
}

export function buildTelegramWatchUrl(botUsername: string, watchToken: string): string {
  return `https://t.me/${botUsername}?start=w_${watchToken}`
}

export function canPreviewPublicly(sizeBytes: number | null, limitBytes: number): boolean {
  if (sizeBytes === null) return false
  return sizeBytes <= limitBytes
}

export function canPreviewMedia(
  sizeBytes: number | null,
  botApiLimitBytes: number,
  mtprotoWorkerReady: boolean
): boolean {
  return sizeBytes !== null && (sizeBytes <= botApiLimitBytes || mtprotoWorkerReady)
}

export function buildStreamingHeaders(input: {
  mediaId: string
  fileUniqueId: string | null
  fileName: string | null
  mimeType: string | null
  sizeBytes: number
  updatedAt: Date
  range: ParsedRangeHeader | null
}): Record<string, string> {
  const fileName = sanitizeFilename(input.fileName) ?? input.mediaId
  const contentType = input.mimeType
  const validContentType =
    contentType && /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(contentType)
      ? contentType
      : 'application/octet-stream'
  const etag = createHash('sha256')
    .update(
      `${input.mediaId}\0${input.fileUniqueId ?? ''}\0${input.sizeBytes}\0${input.updatedAt.toISOString()}`
    )
    .digest('base64url')

  return {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-cache',
    'Content-Disposition': `inline; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'Content-Length': String(input.range?.length ?? input.sizeBytes),
    'Content-Type': validContentType,
    ETag: `"${etag}"`,
    'Referrer-Policy': 'no-referrer',
    ...(input.range
      ? { 'Content-Range': `bytes ${input.range.start}-${input.range.end}/${input.sizeBytes}` }
      : {}),
  }
}
