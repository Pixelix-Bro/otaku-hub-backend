import { hashWatchToken } from './watch-token.service.js'

export function normalizeWatchToken(token: string): string {
  return token.trim().replace(/^w_/, '')
}

export function verifyWatchToken(token: string, tokenHash: string): boolean {
  return hashWatchToken(token) === tokenHash
}

export function buildStartPayloadToken(token: string): string {
  return `w_${normalizeWatchToken(token)}`
}
