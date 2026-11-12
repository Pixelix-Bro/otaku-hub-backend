import { constantTimeCompare } from '../../core/utils/index.js'

export function parseAdminTelegramIds(rawIds: string): number[] {
  return rawIds
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((id) => Number.isInteger(id) && id > 0)
}

export function isAdminTelegramId(userId: number, adminIds: number[]): boolean {
  return adminIds.includes(userId)
}

export function filterAllowedAdmins(userId: number, adminIds: number[]): boolean {
  return isAdminTelegramId(userId, adminIds)
}

export function isValidAdminApiToken(
  authorization: string | undefined,
  expectedToken: string | undefined
): boolean {
  if (!authorization || !expectedToken) return false
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization)
  return Boolean(match && constantTimeCompare(match[1], expectedToken))
}
