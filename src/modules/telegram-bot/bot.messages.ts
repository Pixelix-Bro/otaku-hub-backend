export function getBotWelcomeMessage(botUsername: string): string {
  return `Welcome to ${botUsername}. Upload a file and it will be stored using Telegram Cloud only.`
}

export function buildStoredMediaMessage(input: {
  mediaType: string
  fileName: string | null
  mediaId: string
  sizeLabel: string | null
  mimeType: string | null
  formatLabel: string | null
  durationLabel: string | null
  resolutionLabel: string | null
  watchUrl: string
}) {
  const emojiByType: Record<string, string> = {
    video: '🎬',
    document: '📄',
    audio: '🎵',
    photo: '🖼',
    animation: '🎞',
    voice: '🎙',
    sticker: '📎',
    video_note: '🎬',
  }

  const labelByType: Record<string, string> = {
    video: 'VIDEO',
    document: input.formatLabel?.toUpperCase() === 'PDF' ? 'PDF' : 'DOCUMENT',
    audio: 'AUDIO',
    photo: 'RASM',
    animation: 'ANIMATION',
    voice: 'VOICE',
    sticker: 'STICKER',
    video_note: 'VIDEO NOTE',
  }

  const mediaType = String(input.mediaType ?? 'document').toLowerCase()
  const emoji = emojiByType[mediaType] ?? '📦'
  const typeLabel = labelByType[mediaType] ?? String(input.mediaType).toUpperCase()
  const fileName = input.fileName ?? 'Mavjud emas'
  const lines = [
    `${emoji} ${typeLabel} MUVAFFAQIYATLI SAQLANDI!`,
    '',
    `📁 Fayl nomi: ${fileName}`,
    `🆔 Media ID: ${input.mediaId}`,
    `📦 Hajmi: ${input.sizeLabel ?? 'Noma`lum'}`,
    `🎞 MIME Type: ${input.mimeType ?? 'Noma`lum'}`,
  ]

  if (input.formatLabel) {
    lines.push(`📂 Format: ${input.formatLabel}`)
  }

  if (input.durationLabel) {
    lines.push(`⏱ Davomiyligi: ${input.durationLabel}`)
  }

  if (input.resolutionLabel) {
    lines.push(`📐 Resolution: ${input.resolutionLabel}`)
  }

  lines.push('☁️ Storage: Telegram Cloud')
  lines.push('📍 Status: STORED')
  lines.push('🌐 Web Preview: Mavjud emas')
  lines.push('')

  if (mediaType === 'document') {
    lines.push(`🔗 Telegram orqali ochish: ${input.watchUrl}`)
  } else {
    lines.push(`🔗 Telegram orqali tomosha qilish: ${input.watchUrl}`)
  }

  return lines.join('\n')
}
