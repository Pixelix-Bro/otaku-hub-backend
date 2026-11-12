import { createHash, randomBytes } from 'node:crypto'

export interface WatchTokenData {
  token: string
  tokenHash: string
  mediaId: string
  expiresAt?: Date
  maxUses?: number
  createdAt: Date
}

export function hashWatchToken(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex')
}

export function createWatchTokenData(input: {
  mediaId: string
  expiresAt?: Date
  maxUses?: number
  createdAt?: Date
}): WatchTokenData {
  const token = randomBytes(32).toString('base64url')
  return {
    token,
    tokenHash: hashWatchToken(token),
    mediaId: input.mediaId,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
    createdAt: input.createdAt ?? new Date(),
  }
}

export function parseWatchStartPayload(payload: string | undefined): string | null {
  if (!payload || payload.length > 64) return null
  const match = /^w_([A-Za-z0-9_-]{1,62})$/.exec(payload)
  return match?.[1] ?? null
}

export function verifyWatchToken(token: string, tokenHash: string): boolean {
  return hashWatchToken(token) === tokenHash
}

export function isWatchTokenExpired(expiresAt?: Date): boolean {
  return expiresAt !== undefined && Date.now() > new Date(expiresAt).getTime()
}

export function isWatchTokenUsable(tokenRecord: {
  expiresAt?: Date
  maxUses?: number
  usedCount: number
}): boolean {
  return (
    !isWatchTokenExpired(tokenRecord.expiresAt) &&
    (tokenRecord.maxUses === undefined || tokenRecord.usedCount < tokenRecord.maxUses)
  )
}

export function consumeWatchToken(tokenRecord: {
  usedCount: number
  maxUses?: number
  expiresAt?: Date
}): boolean {
  if (!isWatchTokenUsable(tokenRecord)) {
    return false
  }

  tokenRecord.usedCount += 1
  return true
}
