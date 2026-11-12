import { createHash } from 'node:crypto'

import type { ParsedRangeHeader } from '../../core/utils/index.js'
import { sanitizeFilename } from '../../core/utils/index.js'

export async function* readByteRange(
  chunks: AsyncIterable<Uint8Array>,
  start: number,
  length: number
): AsyncGenerator<Uint8Array> {
  let offset = 0
  let remaining = length

  for await (const chunk of chunks) {
    const chunkStart = offset
    offset += chunk.byteLength
    if (offset <= start) continue

    const sliceStart = Math.max(0, start - chunkStart)
    const sliceEnd = Math.min(chunk.byteLength, sliceStart + remaining)
    if (sliceEnd > sliceStart) {
      const slice = chunk.subarray(sliceStart, sliceEnd)
      yield slice
      remaining -= slice.byteLength
    }
    if (remaining === 0) return
  }

  if (remaining > 0) {
    throw new Error('Upstream ended before the requested byte range was complete')
  }
}

export function shouldHonorRange(
  ifRange: string | undefined,
  etag: string,
  lastModified: Date
): boolean {
  if (!ifRange) return true
  if (ifRange.startsWith('W/')) return false
  if (ifRange.startsWith('"')) return ifRange === etag

  const ifRangeDate = Date.parse(ifRange)
  return (
    Number.isFinite(ifRangeDate) && Math.floor(lastModified.getTime() / 1000) * 1000 <= ifRangeDate
  )
}

export function shouldReturnNotModified(
  ifNoneMatch: string | undefined,
  ifModifiedSince: string | undefined,
  etag: string,
  lastModified: Date
): boolean {
  if (ifNoneMatch) {
    return ifNoneMatch.split(',').some((candidate) => {
      const normalized = candidate.trim().replace(/^W\//, '')
      return normalized === '*' || normalized === etag
    })
  }

  if (!ifModifiedSince) return false
  const modifiedSince = Date.parse(ifModifiedSince)
  return (
    Number.isFinite(modifiedSince) &&
    Math.floor(lastModified.getTime() / 1000) * 1000 <= modifiedSince
  )
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export async function fetchWithRetry(
  fetcher: FetchLike,
  url: string,
  init: RequestInit,
  maxAttempts = 3
): Promise<Response> {
  const signal = init.signal
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetcher(url, init)
      if ((response.status !== 429 && response.status < 500) || attempt === maxAttempts) {
        return response
      }

      const retryAfterValue = response.headers.get('retry-after')
      const retryAfter = retryAfterValue === null ? Number.NaN : Number(retryAfterValue)
      await response.body?.cancel().catch(() => undefined)
      const delayMs = Number.isFinite(retryAfter)
        ? Math.min(Math.max(retryAfter * 1000, 0), 5000)
        : 200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100)
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    } catch (error) {
      lastError = error
      if (signal?.aborted || attempt === maxAttempts) throw error
      await new Promise<void>((resolve) =>
        setTimeout(resolve, 200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100))
      )
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Upstream request failed')
}

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

export function canPreviewMedia(sizeBytes: number | null): boolean {
  return sizeBytes !== null && sizeBytes > 0
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
    'Last-Modified': input.updatedAt.toUTCString(),
    'Referrer-Policy': 'no-referrer',
    ...(input.range
      ? { 'Content-Range': `bytes ${input.range.start}-${input.range.end}/${input.sizeBytes}` }
      : {}),
  }
}
