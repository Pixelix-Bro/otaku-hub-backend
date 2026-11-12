import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Format file size to human-readable string using 1024 base.
 */
export function formatFileSize(bytes: number | null): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return null
  }
  if (bytes === 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`
}

/**
 * Generate unique Media ID in format MED_XXXXXXXX (8 uppercase hex chars).
 */
export function generateMediaId(): string {
  const bytes = randomBytes(4)
  const hex = bytes.toString('hex').toUpperCase()
  return `MED_${hex}`
}

/**
 * Sanitize filename — remove dangerous characters, limit length.
 */
export function sanitizeFilename(name: string | null | undefined): string | null {
  if (!name) return null
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\.{2,}/g, '.')
    .substring(0, 255)
    .trim()
}

/**
 * Extract file extension from filename or MIME type.
 */
export function extractExtension(fileName: string | null, mimeType: string | null): string | null {
  if (fileName) {
    const parts = fileName.split('.')
    if (parts.length > 1) {
      const ext = parts[parts.length - 1]
      if (ext && ext.length <= 10) {
        return ext.toLowerCase()
      }
    }
  }

  if (mimeType) {
    const mimeToExt: Record<string, string> = {
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
      'video/x-matroska': 'mkv',
      'video/x-msvideo': 'avi',
      'video/webm': 'webm',
      'video/mpeg': 'mpeg',
      'video/3gpp': '3gp',
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
      'image/gif': 'gif',
      'image/avif': 'avif',
      'image/tiff': 'tiff',
      'image/bmp': 'bmp',
      'application/pdf': 'pdf',
      'application/zip': 'zip',
      'application/x-rar-compressed': 'rar',
      'text/plain': 'txt',
    }
    return mimeToExt[mimeType] ?? null
  }

  return null
}

/**
 * Constant-time string comparison for secrets.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, 'utf-8')
    const bufB = Buffer.from(b, 'utf-8')
    if (bufA.length !== bufB.length) return false
    return timingSafeEqual(bufA, bufB)
  } catch {
    return false
  }
}

/**
 * SHA-256 hash a token string.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex')
}

/**
 * Generate a cryptographically secure URL-safe token.
 * Short enough for Telegram deep link start parameter (max 64 chars).
 */
export function generateSecureToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Sleep for given milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Redact bot token from URLs for safe logging.
 */
export function redactToken(text: string): string {
  return text.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***:REDACTED')
}

/**
 * Format duration in seconds to MM:SS or HH:MM:SS string.
 */
export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null
  const totalSeconds = Math.round(seconds)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * Validate Media ID format: MED_XXXXXXXX
 */
export function isValidMediaId(id: string): boolean {
  return /^MED_[0-9A-F]{8}$/.test(id)
}

export interface ParsedRangeHeader {
  start: number
  end: number
  length: number
  isSuffix: boolean
}

export function isMultipartRangeHeader(rangeHeader: string | undefined): boolean {
  return Boolean(rangeHeader && /^\s*bytes\s*=/i.test(rangeHeader) && rangeHeader.includes(','))
}

export function parseRangeHeader(
  rangeHeader: string | undefined,
  totalSize: number
): ParsedRangeHeader | null {
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0 || !rangeHeader) {
    return null
  }

  const match = /^\s*bytes\s*=\s*(.+)\s*$/i.exec(rangeHeader)
  if (!match) {
    return null
  }

  const raw = match[1].trim()
  if (!raw || raw.includes(',')) {
    return null
  }

  const suffixMatch = /^-(\d+)$/i.exec(raw)
  if (suffixMatch) {
    const suffixLength = Number(suffixMatch[1])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null
    }
    const start = Math.max(totalSize - Math.min(suffixLength, totalSize), 0)
    const end = totalSize - 1
    return { start, end, length: end - start + 1, isSuffix: true }
  }

  const rangeMatch = /^(\d*)-(\d*)$/i.exec(raw)
  if (!rangeMatch) {
    return null
  }

  const startRaw = rangeMatch[1]
  const endRaw = rangeMatch[2]
  const start = startRaw === '' ? 0 : Number(startRaw)
  const requestedEnd = endRaw === '' ? totalSize - 1 : Number(endRaw)

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= totalSize
  ) {
    return null
  }

  const end = Math.min(requestedEnd, totalSize - 1)
  return { start, end, length: end - start + 1, isSuffix: false }
}
