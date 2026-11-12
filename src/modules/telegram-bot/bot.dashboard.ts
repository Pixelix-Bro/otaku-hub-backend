import type { Filter } from 'mongodb'

import { COLLECTIONS } from '../../config/constants.js'
import { getConfig } from '../../config/env.js'
import { formatDuration, formatFileSize } from '../../core/utils/index.js'
import { getDb, isMongoDBHealthy } from '../../infrastructure/mongodb/client.js'
import { MtprotoWorkerClient } from '../../infrastructure/telegram/mtproto-worker.client.js'
import { getTelegramService } from '../../infrastructure/telegram/telegram.service.js'
import type { MediaDocumentLike } from '../media/media.service.js'

export interface InlineButton {
  text: string
  callback_data: string
}

export interface DashboardView {
  text: string
  reply_markup: { inline_keyboard: InlineButton[][] }
}

export function callbackData(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > 64) {
    throw new RangeError('Telegram callback_data must not exceed 64 bytes.')
  }
  return value
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return entities[character]!
  })
}

function button(text: string, callback: string): InlineButton {
  return { text, callback_data: callbackData(callback) }
}

function icon(ok: boolean): string {
  return ok ? '🟢' : '🔴'
}

async function checkWebsite(url: string): Promise<boolean> {
  if (!url) return false
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3_000) })
    return response.ok
  } catch {
    return false
  }
}

async function getStatistics() {
  const media = getDb().collection(COLLECTIONS.MEDIA)
  const active = { deletedAt: null }
  const [total, video, photo, audio, documents, ready, processing, failed, size] =
    await Promise.all([
      media.countDocuments(active),
      media.countDocuments({ ...active, mediaType: 'video' }),
      media.countDocuments({ ...active, mediaType: 'photo' }),
      media.countDocuments({ ...active, mediaType: 'audio' }),
      media.countDocuments({ ...active, mediaType: 'document' }),
      media.countDocuments({ ...active, storageStatus: 'stored', mtprotoStatus: 'available' }),
      media.countDocuments({ ...active, storageStatus: { $in: ['pending', 'copying'] } }),
      media.countDocuments({ ...active, storageStatus: { $in: ['copy_failed', 'copy_unknown'] } }),
      media
        .aggregate([
          { $match: { ...active, storageStatus: 'stored' } },
          { $group: { _id: null, bytes: { $sum: '$sizeBytes' } } },
        ])
        .toArray(),
    ])
  return {
    total,
    video,
    photo,
    audio,
    documents,
    ready,
    processing,
    failed,
    sizeBytes: Number(size[0]?.bytes ?? 0),
  }
}

export async function renderDashboard(): Promise<DashboardView> {
  const config = getConfig()
  const workerConfigured = Boolean(config.telegramWorkerUrl && config.telegramWorkerSecret)
  const [database, telegram, storage, worker, api, website, statistics] = await Promise.all([
    isMongoDBHealthy().catch(() => false),
    getTelegramService()
      .getBotApiClient()
      .getMe()
      .then(() => true)
      .catch(() => false),
    getTelegramService()
      .getStorageChannel()
      .validate()
      .then(() => true)
      .catch(() => false),
    workerConfigured
      ? new MtprotoWorkerClient(config.telegramWorkerUrl!, config.telegramWorkerSecret!).isReady()
      : Promise.resolve(false),
    checkWebsite(`${config.publicApiUrl}/health/live`),
    checkWebsite(config.publicWebUrl),
    isMongoDBHealthy()
      .then((healthy) => (healthy ? getStatistics() : null))
      .catch(() => null),
  ])

  const statisticsText = statistics
    ? `🎬 Jami media: ${statistics.total}\n📦 Saqlangan hajm: ${formatFileSize(statistics.sizeBytes)}\n🟢 Tayyor: ${statistics.ready}\n🟡 Jarayonda: ${statistics.processing}\n🔴 Xatolik: ${statistics.failed}`
    : 'Ma’lumotlar bazasi statistikasi mavjud emas.'
  const text = [
    '🎬 <b>XENVO MEDIA CONTROL PANEL</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    '👋 Xush kelibsiz, Administrator!',
    '',
    '<b>ASOSIY TIZIM HOLATI</b>',
    `${icon(telegram)} Telegram Bot API: ${telegram ? 'Online' : 'Mavjud emas'}`,
    `${icon(storage)} Telegram Storage: ${storage ? 'Connected' : 'Mavjud emas'}`,
    `${icon(worker)} MTProto Worker: ${worker ? 'Online' : 'Mavjud emas'}`,
    `${icon(database)} Database: ${database ? 'Online' : 'Mavjud emas'}`,
    `${icon(api)} Media API: ${api ? 'Online' : 'Mavjud emas'}`,
    `${icon(website)} Website: ${website ? 'Available' : 'Mavjud emas'}`,
    '',
    '<b>MEDIA STATISTIKASI</b>',
    statisticsText,
    '',
    `🕒 Tekshirildi: ${new Date().toISOString()}`,
    '━━━━━━━━━━━━━━━━━━━━',
    'Kerakli bo‘limni tanlang.',
  ].join('\n')

  return {
    text,
    reply_markup: {
      inline_keyboard: [
        [button('📤 Media yuklash', 'menu:upload')],
        [button('📚 Media kutubxonasi', 'library:1:all')],
        [button('📊 Statistika', 'menu:stats'), button('⚙️ Sozlamalar', 'menu:settings')],
        [button('🖥 Tizim monitoringi', 'menu:monitor')],
        [button('❓ Yordam', 'menu:help')],
      ],
    },
  }
}

export function renderUploadPrompt(): DashboardView {
  return {
    text: [
      '📤 <b>MEDIA YUKLASH</b>',
      '━━━━━━━━━━━━━━━━━━━━',
      'XENVO tizimiga video, rasm, audio yoki hujjat yuboring.',
      'Fayl hajmi Telegram va streaming worker imkoniyatlari bilan tekshiriladi.',
      'Faylni ushbu private chatga yuboring.',
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [
        [button('📚 Media kutubxonasi', 'library:1:all')],
        [button('🏠 Asosiy menyu', 'menu:home')],
      ],
    },
  }
}

export async function renderStatistics(): Promise<DashboardView> {
  const stats = await getStatistics()
  return {
    text: [
      '📊 <b>XENVO STATISTIKA</b>',
      '━━━━━━━━━━━━━━━━━━━━',
      `🎬 Jami media: ${stats.total}`,
      `📦 Saqlangan hajm: ${formatFileSize(stats.sizeBytes)}`,
      `🎞 Video: ${stats.video}`,
      `🖼 Rasm: ${stats.photo}`,
      `🎵 Audio: ${stats.audio}`,
      `📄 Hujjat: ${stats.documents}`,
      `🟢 MTProto orqali tayyor: ${stats.ready}`,
      `🟡 Jarayonda: ${stats.processing}`,
      `🔴 Xatolik: ${stats.failed}`,
      '━━━━━━━━━━━━━━━━━━━━',
    ].join('\n'),
    reply_markup: { inline_keyboard: [[button('🏠 Asosiy menyu', 'menu:home')]] },
  }
}

export async function renderMonitor(): Promise<DashboardView> {
  const config = getConfig()
  const workerConfigured = Boolean(config.telegramWorkerUrl && config.telegramWorkerSecret)
  const [database, worker, telegram, storage] = await Promise.all([
    isMongoDBHealthy().catch(() => false),
    workerConfigured
      ? new MtprotoWorkerClient(config.telegramWorkerUrl!, config.telegramWorkerSecret!).isReady()
      : Promise.resolve(false),
    getTelegramService()
      .getBotApiClient()
      .getMe()
      .then(() => true)
      .catch(() => false),
    getTelegramService()
      .getStorageChannel()
      .validate()
      .then(() => true)
      .catch(() => false),
  ])
  return {
    text: [
      '🖥 <b>XENVO SYSTEM MONITOR</b>',
      '━━━━━━━━━━━━━━━━━━━━',
      '<b>SERVICES</b>',
      `${icon(telegram)} Telegram Bot API: ${telegram ? 'Online' : 'Mavjud emas'}`,
      `${icon(storage)} Telegram Storage: ${storage ? 'Connected' : 'Mavjud emas'}`,
      `${icon(worker)} MTProto Worker: ${worker ? 'Online' : 'Mavjud emas'}`,
      `${icon(database)} MongoDB: ${database ? 'Online' : 'Mavjud emas'}`,
      'Backend API: Online (ushbu javobdan tasdiqlandi)',
      'Website media playback: jonli tekshiruv worker/stream holatini talab qiladi.',
      `🕒 Tekshirildi: ${new Date().toISOString()}`,
      '━━━━━━━━━━━━━━━━━━━━',
    ].join('\n'),
    reply_markup: { inline_keyboard: [[button('🏠 Asosiy menyu', 'menu:home')]] },
  }
}

export function renderHelp(): DashboardView {
  return {
    text: [
      '❓ <b>XENVO YORDAM</b>',
      '━━━━━━━━━━━━━━━━━━━━',
      'Media yuklash: “Media yuklash” tugmasini bosing va faylni botga yuboring.',
      'Kutubxona: saqlangan media ro‘yxati va tafsilotlarini oching.',
      'Sayt preview: kichik fayllar Bot API, katta fayllar esa MTProto worker tayyor bo‘lsa ochiladi.',
      '━━━━━━━━━━━━━━━━━━━━',
    ].join('\n'),
    reply_markup: { inline_keyboard: [[button('🏠 Asosiy menyu', 'menu:home')]] },
  }
}

export function renderSettings(): DashboardView {
  return {
    text: [
      '⚙️ <b>XENVO SOZLAMALARI</b>',
      '━━━━━━━━━━━━━━━━━━━━',
      'Sozlamalarni bot orqali o‘zgartirish hozircha mavjud emas.',
      'Backend sirlarini va Telegram credential’larini bot orqali o‘zgartirib bo‘lmaydi.',
      '━━━━━━━━━━━━━━━━━━━━',
    ].join('\n'),
    reply_markup: { inline_keyboard: [[button('🏠 Asosiy menyu', 'menu:home')]] },
  }
}

export async function renderLibrary(page = 1, mediaType = 'all'): Promise<DashboardView> {
  const collection = getDb().collection<MediaDocumentLike>(COLLECTIONS.MEDIA)
  const safePage = Number.isSafeInteger(page) && page > 0 ? page : 1
  const validFilters = [
    'all',
    'video',
    'photo',
    'audio',
    'document',
    'processing',
    'failed',
    'public',
    'private',
  ]
  const safeType = validFilters.includes(mediaType) ? mediaType : 'all'
  const filter: Filter<MediaDocumentLike> = { deletedAt: null }
  if (
    safeType === 'video' ||
    safeType === 'photo' ||
    safeType === 'audio' ||
    safeType === 'document'
  ) {
    filter.mediaType = safeType
  } else if (safeType === 'processing') {
    filter.storageStatus = { $in: ['pending', 'copying'] }
  } else if (safeType === 'failed') {
    filter.$or = [
      { storageStatus: { $in: ['copy_failed', 'copy_unknown'] } },
      { mtprotoStatus: 'unavailable' },
    ]
  } else if (safeType === 'public' || safeType === 'private') {
    filter.visibility = safeType
  }
  const pageSize = 5
  const total = await collection.countDocuments(filter)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const actualPage = Math.min(safePage, totalPages)
  const rows = await collection
    .find(filter)
    .sort({ createdAt: -1, mediaId: 1 })
    .skip((actualPage - 1) * pageSize)
    .limit(pageSize)
    .toArray()
  const text = rows.length
    ? [
        '📚 <b>XENVO MEDIA KUTUBXONASI</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        ...rows.map(
          (item) =>
            `🎬 <b>${escapeHtml(item.fileName ?? 'Noma’lum')}</b>\n📦 ${formatFileSize(item.sizeBytes) ?? 'Noma’lum'} · ${escapeHtml(item.storageStatus)} · ${escapeHtml(item.mediaId)}`
        ),
        '━━━━━━━━━━━━━━━━━━━━',
        `Filter: ${escapeHtml(safeType)} · Sahifa ${actualPage}/${totalPages} · Jami ${total}`,
      ].join('\n\n')
    : '📚 <b>MEDIA KUTUBXONASI</b>\n\nBu filterda media topilmadi.'
  const keyboard: InlineButton[][] = rows.map((item) => [
    button(`📊 ${item.fileName ?? item.mediaId}`.slice(0, 60), `media:detail:${item.mediaId}`),
  ])
  keyboard.push([
    button('⬅️', `library:${Math.max(1, actualPage - 1)}:${safeType}`),
    button('➡️', `library:${Math.min(totalPages, actualPage + 1)}:${safeType}`),
  ])
  keyboard.push([
    button('Hammasi', 'library:1:all'),
    button('Video', 'library:1:video'),
    button('Rasmlar', 'library:1:photo'),
  ])
  keyboard.push([
    button('Audio', 'library:1:audio'),
    button('Hujjatlar', 'library:1:document'),
    button('🏠', 'menu:home'),
  ])
  keyboard.push([
    button('🟡 Jarayonda', 'library:1:processing'),
    button('🔴 Xatolik', 'library:1:failed'),
  ])
  keyboard.push([
    button('🌍 Public', 'library:1:public'),
    button('🔒 Private', 'library:1:private'),
    button('🔎 Qidirish', 'library:search'),
  ])
  return { text, reply_markup: { inline_keyboard: keyboard } }
}

export function renderMediaDetails(media: MediaDocumentLike): DashboardView {
  const filename = escapeHtml(media.fileName ?? 'Noma’lum')
  const webReady = media.storageStatus === 'stored' && media.mtprotoStatus === 'available'
  return {
    text: [
      '📊 <b>MEDIA TAFSILOTLARI</b>',
      '━━━━━━━━━━━━━━━━━━━━',
      `<b>UMUMIY MA’LUMOT</b>`,
      `🆔 Media ID: <code>${escapeHtml(media.mediaId)}</code>`,
      `🎬 Nomi: ${filename}`,
      `📦 Hajmi: ${media.sizeBytes ?? 'Noma’lum'} bytes (${formatFileSize(media.sizeBytes) ?? 'Noma’lum'})`,
      `🎥 MIME: ${escapeHtml(media.mimeType ?? 'Noma’lum')}`,
      `📅 Yuklangan: ${media.createdAt.toISOString()}`,
      '',
      '<b>MEDIA</b>',
      `⏱ Davomiyligi: ${formatDuration(media.durationSeconds) ?? 'Noma’lum'}`,
      `📺 Resolution: ${media.width && media.height ? `${media.width} × ${media.height}` : 'Noma’lum'}`,
      `📍 Processing: ${escapeHtml(media.storageStatus)}`,
      `🔐 Visibility: ${escapeHtml(media.visibility)}`,
      '',
      '<b>TELEGRAM / STREAMING</b>',
      `Source chat ID: <code>${escapeHtml(media.sourceChatId)}</code>`,
      `Source message ID: <code>${media.sourceMessageId}</code>`,
      `Telegram file ID: <code>${escapeHtml(media.telegramFileId ?? 'Noma’lum')}</code>`,
      `MTProto: ${escapeHtml(media.mtprotoStatus ?? 'unavailable')}`,
      `Website streaming: ${webReady ? 'MTProto source resolved' : 'Not verified'}`,
      '━━━━━━━━━━━━━━━━━━━━',
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [
        [button('🔗 Sayt linkini olish', `media:preview:${media.mediaId}`)],
        [
          button('🌍 Public qilish', `media:publish:${media.mediaId}`),
          button('🔒 Private qilish', `media:unpublish:${media.mediaId}`),
        ],
        [button('🗑 Media’ni o‘chirish', `media:delete:${media.mediaId}`)],
        [button('⬅️ Kutubxonaga', 'library:1:all'), button('🏠', 'menu:home')],
      ],
    },
  }
}
