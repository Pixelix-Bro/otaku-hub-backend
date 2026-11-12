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
  webPreviewUrl?: string | null
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
  const streamingReady = Boolean(input.webPreviewUrl)
  const lines = [
    streamingReady
      ? `${emoji} ${typeLabel} XENVO STREAMING’GA TAYYOR!`
      : `${emoji} ${typeLabel} TELEGRAM’DA SAQLANDI, STREAMING TASDIQLANMAGAN`,
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
  lines.push('📍 Storage: STORED')
  lines.push(`🌐 Website streaming: ${streamingReady ? 'READY' : 'NOT VERIFIED'}`)
  lines.push(
    input.webPreviewUrl
      ? `🔗 XENVO’da tomosha qilish: ${input.webPreviewUrl}`
      : '🔗 Web preview: Mavjud emas'
  )

  return lines.join('\n')
}
