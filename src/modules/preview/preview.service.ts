export function buildPreviewUrl(publicBaseUrl: string, mediaId: string): string | null {
  if (!publicBaseUrl) return null
  return `${publicBaseUrl.replace(/\/+$/, '')}/v1/preview/${mediaId}`
}

export function buildTelegramWatchUrl(botUsername: string, watchToken: string): string {
  return `https://t.me/${botUsername}?start=w_${watchToken}`
}

export function canPreviewPublicly(sizeBytes: number | null, limitBytes: number): boolean {
  if (sizeBytes === null) return false
  return sizeBytes <= limitBytes
}
