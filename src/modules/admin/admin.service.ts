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
