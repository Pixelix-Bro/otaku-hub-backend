import { COLLECTIONS } from '../../config/constants.js'
import { getConfig } from '../../config/env.js'
import { TelegramApiError } from '../../core/errors/app-error.js'
import type { TelegramMessage, TelegramUpdate } from '../../core/types/index.js'
import { formatDuration, formatFileSize } from '../../core/utils/index.js'
import { getCollection } from '../../infrastructure/mongodb/client.js'
import { getTelegramService } from '../../infrastructure/telegram/telegram.service.js'
import { isAdminTelegramId } from '../admin/admin.service.js'
import { getTelegramMediaMetadata, isSupportedTelegramMediaMessage } from '../media/media-id.js'
import {
  createMediaRecord,
  getMediaById,
  getMediaBySourceMessage,
  setMediaVisibility,
  softDeleteMedia,
  updateMediaStorage,
} from '../media/media.service.js'
import { buildPreviewUrl, buildTelegramWatchUrl } from '../preview/preview.service.js'
import { WatchTokenRepository } from '../watch/watch-token.repository.js'
import {
  createWatchTokenData,
  hashWatchToken,
  isWatchTokenUsable,
  parseWatchStartPayload,
} from '../watch/watch-token.service.js'
import { buildStoredMediaMessage } from './bot.messages.js'

const watchTokens = new WatchTokenRepository()

async function reply(message: TelegramMessage, text: string): Promise<void> {
  await getTelegramService().getBotApiClient().sendMessage(message.chat.id, text)
}

async function processStart(message: TelegramMessage): Promise<void> {
  const config = getConfig()
  const userId = message.from?.id
  if (!userId || message.chat.type !== 'private') {
    await reply(message, 'Media faqat botning private chatida ochiladi.')
    return
  }

  const payload = message.text?.trim().split(/\s+/, 2)[1]
  const token = parseWatchStartPayload(payload)
  if (!token) {
    const welcome =
      userId && isAdminTelegramId(userId, config.adminTelegramIds)
        ? 'Bot tayyor. Fayl yuboring yoki /help yuboring.'
        : 'Salom! Media havolasini ochish uchun Watch tugmasidan foydalaning.'
    await reply(message, welcome)
    return
  }

  const tokenHash = hashWatchToken(token)
  const tokenRecord = await watchTokens.findByHash(tokenHash)
  if (!tokenRecord || !isWatchTokenUsable(tokenRecord)) {
    await reply(message, 'Havola yaroqsiz, muddati tugagan yoki foydalanish limiti tugagan.')
    return
  }

  const media = await getMediaById(tokenRecord.mediaId)
  if (!media || media.storageStatus !== 'stored' || media.storageMessageId === null) {
    await reply(message, 'Media hozir mavjud emas.')
    return
  }

  if (media.visibility === 'private' && media.sourceChatId !== String(userId)) {
    await reply(message, '⛔ Sizda ushbu media uchun ruxsat mavjud emas.')
    return
  }
  if (media.visibility !== 'private' && media.visibility !== 'public') {
    await reply(message, 'Media uchun kirish ruxsati mavjud emas.')
    return
  }

  const claimedToken = await watchTokens.consumeIfUsable(tokenHash)
  if (!claimedToken) {
    await reply(message, 'Havola yaroqsiz, muddati tugagan yoki foydalanish limiti tugagan.')
    return
  }

  try {
    await getTelegramService()
      .getStorageChannel()
      .copyMediaToUser(media.storageMessageId, message.chat.id)
  } catch {
    await reply(message, 'Media Telegram orqali yuborilmadi. Keyinroq qayta urinib ko‘ring.')
  }
}

async function processAdminUpload(message: TelegramMessage): Promise<void> {
  const config = getConfig()
  const userId = message.from?.id
  const api = getTelegramService().getBotApiClient()

  if (!userId || !isAdminTelegramId(userId, config.adminTelegramIds)) {
    await reply(message, '⛔ Sizda admin ruxsati mavjud emas.')
    return
  }
  if (message.chat.type !== 'private' || String(message.chat.id) !== String(userId)) {
    await reply(message, 'Upload faqat bot bilan private chatda ruxsat etiladi.')
    return
  }
  if (!isSupportedTelegramMediaMessage(message)) {
    await reply(message, 'Telegram media turi aniqlanmadi yoki fayl metadata mavjud emas.')
    return
  }

  const existing = await getMediaBySourceMessage(String(message.chat.id), message.message_id)
  if (existing) {
    await reply(
      message,
      existing.storageStatus === 'copy_unknown'
        ? `Media ${existing.mediaId} nusxasi holati noma’lum; private storage channel’da qo‘lda tekshiring.`
        : `Bu xabar avval qabul qilingan. Media ID: ${existing.mediaId}; status: ${existing.storageStatus}.`
    )
    return
  }

  const metadata = getTelegramMediaMetadata(message)
  const media = await createMediaRecord({
    ...metadata,
    sourceChatId: String(message.chat.id),
    sourceMessageId: message.message_id,
    storageChatId: config.telegramStorageChatId,
    storageStatus: 'pending',
    visibility: 'private',
  })

  let storageMessageId: number
  try {
    await updateMediaStorage(media.mediaId, { storageStatus: 'copying' })
    const result = await getTelegramService()
      .getStorageChannel()
      .copyMediaToStorage(message.chat.id, message.message_id)
    storageMessageId = result.storageMessageId
  } catch (error) {
    await updateMediaStorage(media.mediaId, { storageStatus: 'copy_unknown' })
    await reply(
      message,
      'Media nusxasi holati noma’lum. Duplicate nusxa yaratilmasligi uchun qayta yuborilmadi; reconcile talab qilinadi.'
    )
    throw error
  }

  const stored = await updateMediaStorage(media.mediaId, {
    storageStatus: 'stored',
    storageMessageId,
  })
  if (!stored) {
    await reply(
      message,
      'Telegram nusxa yaratdi, ammo metadata yangilanmadi. Media holati qo‘lda tekshirilishi kerak.'
    )
    return
  }

  try {
    const token = createWatchTokenData({
      mediaId: media.mediaId,
      expiresAt: new Date(Date.now() + config.watchTokenTtlSeconds * 1000),
      maxUses: config.maxWatchTokenUses,
    })
    await watchTokens.create({ ...token, usedCount: 0 })

    const webPreviewUrl =
      metadata.sizeBytes !== null &&
      metadata.sizeBytes <= config.botApiDownloadMaxBytes &&
      config.publicApiUrl
        ? `${buildPreviewUrl(config.publicApiUrl, media.mediaId)}?token=${encodeURIComponent(token.token)}`
        : null

    await api.sendMessage(
      message.chat.id,
      buildStoredMediaMessage({
        mediaType: metadata.mediaType,
        fileName: metadata.fileName,
        mediaId: media.mediaId,
        sizeLabel: metadata.sizeBytes === null ? null : formatFileSize(metadata.sizeBytes),
        mimeType: metadata.mimeType,
        formatLabel: metadata.extension ? metadata.extension.toUpperCase() : null,
        durationLabel:
          metadata.durationSeconds === null ? null : formatDuration(metadata.durationSeconds),
        resolutionLabel:
          metadata.width && metadata.height ? `${metadata.width} × ${metadata.height}` : null,
        watchUrl: buildTelegramWatchUrl(config.telegramBotUsername, token.token),
        webPreviewUrl,
      })
    )
  } catch (error) {
    await reply(
      message,
      'Media storage’da saqlandi, ammo watch link yaratilmadi. Website orqali yangi link oling.'
    )
    throw error
  }
}

async function processAdminCommand(message: TelegramMessage): Promise<void> {
  const config = getConfig()
  const userId = message.from?.id
  const api = getTelegramService().getBotApiClient()
  const [rawCommand, ...args] = (message.text ?? '').trim().split(/\s+/)
  const command = rawCommand?.split('@')[0]?.toLowerCase()

  if (!userId || !isAdminTelegramId(userId, config.adminTelegramIds)) {
    await reply(message, '⛔ Sizda admin ruxsati mavjud emas.')
    return
  }
  if (message.chat.type !== 'private' || String(message.chat.id) !== String(userId)) {
    await reply(message, 'Admin komandalari faqat botning private chatida ishlaydi.')
    return
  }

  if (command === '/help') {
    await reply(
      message,
      '/start, /stats, /list, /get MEDIA_ID, /preview MEDIA_ID, /search QUERY, /visibility MEDIA_ID public|private, /delete MEDIA_ID, /status, /reconcile'
    )
    return
  }
  if (command === '/stats') {
    const media = getCollection(COLLECTIONS.MEDIA)
    const active = { deletedAt: null }
    const [total, video, pdf, audio, photo, size] = await Promise.all([
      media.countDocuments(active),
      media.countDocuments({ ...active, mediaType: 'video' }),
      media.countDocuments({ ...active, extension: 'pdf' }),
      media.countDocuments({ ...active, mediaType: 'audio' }),
      media.countDocuments({ ...active, mediaType: 'photo' }),
      media
        .aggregate([{ $match: active }, { $group: { _id: null, bytes: { $sum: '$sizeBytes' } } }])
        .toArray(),
    ])
    await reply(
      message,
      `Media: ${total}\nVideo: ${video}\nPDF: ${pdf}\nAudio: ${audio}\nRasm: ${photo}\nMetadata hajmi: ${formatFileSize(size[0]?.bytes ?? 0)}`
    )
    return
  }
  if (command === '/list' || command === '/search') {
    const collection = getCollection(COLLECTIONS.MEDIA)
    const query = command === '/search' ? args.join(' ').trim() : ''
    if (command === '/search' && !query) {
      await reply(message, 'Foydalanish: /search QUERY')
      return
    }
    const filter = query
      ? {
          deletedAt: null,
          $or: [
            { mediaId: query.toUpperCase() },
            { fileName: { $regex: escapeRegExp(query), $options: 'i' } },
          ],
        }
      : { deletedAt: null }
    const rows = await collection.find(filter).sort({ createdAt: -1 }).limit(10).toArray()
    const text = rows.length
      ? rows
          .map(
            (row) =>
              `${escapeHtml(String(row.mediaId))} | ${escapeHtml(String(row.mediaType))} | ${escapeHtml(String(row.fileName ?? 'Mavjud emas'))} | ${escapeHtml(String(row.storageStatus))}`
          )
          .join('\n')
      : 'Media topilmadi.'
    await reply(message, text)
    return
  }
  if (command === '/get') {
    const mediaId = args[0]?.toUpperCase()
    const media = mediaId ? await getMediaById(mediaId) : null
    if (!media || media.storageStatus !== 'stored' || media.storageMessageId === null) {
      await reply(message, 'Stored media topilmadi. Foydalanish: /get MEDIA_ID')
      return
    }
    if (media.visibility === 'private' && media.sourceChatId !== String(userId)) {
      await reply(message, '⛔ Sizda ushbu media uchun ruxsat mavjud emas.')
      return
    }
    await getTelegramService()
      .getStorageChannel()
      .copyMediaToUser(media.storageMessageId, message.chat.id)
    return
  }
  if (command === '/preview') {
    const mediaId = args[0]?.toUpperCase()
    const media = mediaId ? await getMediaById(mediaId) : null
    if (!media || media.storageStatus !== 'stored' || media.storageMessageId === null) {
      await reply(message, 'Stored media topilmadi. Foydalanish: /preview MEDIA_ID')
      return
    }
    if (media.sizeBytes === null || media.sizeBytes > config.botApiDownloadMaxBytes) {
      await reply(
        message,
        `Web preview faqat ${formatFileSize(config.botApiDownloadMaxBytes)} gacha ishlaydi; bu media Telegram Bot API preview limitidan katta yoki hajmi noma’lum.`
      )
      return
    }
    if (!config.publicApiUrl) {
      await reply(message, 'Web preview uchun PUBLIC_API_URL sozlanmagan.')
      return
    }

    const token = createWatchTokenData({
      mediaId: media.mediaId,
      expiresAt: new Date(Date.now() + config.watchTokenTtlSeconds * 1000),
      maxUses: config.maxWatchTokenUses,
    })
    await watchTokens.create({ ...token, usedCount: 0 })
    const previewUrl = `${buildPreviewUrl(config.publicApiUrl, media.mediaId)}?token=${encodeURIComponent(token.token)}`
    await reply(message, `🌐 Web Preview: ${previewUrl}`)
    return
  }
  if (command === '/visibility') {
    const mediaId = args[0]?.toUpperCase()
    const visibility = args[1]?.toLowerCase()
    if (!mediaId || (visibility !== 'public' && visibility !== 'private')) {
      await reply(message, 'Foydalanish: /visibility MEDIA_ID public|private')
      return
    }
    const changed = await setMediaVisibility(mediaId, visibility)
    await reply(
      message,
      changed ? `Media ${mediaId} visibility=${visibility}.` : 'Stored media topilmadi.'
    )
    return
  }
  if (command === '/delete') {
    const mediaId = args[0]?.toUpperCase()
    const media = mediaId ? await getMediaById(mediaId) : null
    if (!media || media.storageStatus !== 'stored' || media.storageMessageId === null) {
      await reply(message, 'Stored media topilmadi. Foydalanish: /delete MEDIA_ID')
      return
    }
    await api.sendMessage(
      message.chat.id,
      `Media ${media.mediaId} ni o'chirishni tasdiqlaysizmi?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Tasdiqlash', callback_data: `del_confirm:${media.mediaId}` },
              { text: 'Bekor qilish', callback_data: 'del_cancel' },
            ],
          ],
        },
      }
    )
    return
  }
  if (command === '/status') {
    await reply(message, 'Bot ishlayapti. Storage channel startup vaqtida tekshirilgan.')
    return
  }
  if (command === '/reconcile') {
    await reply(
      message,
      'Bot API storage channel tarixini o‘qiy olmaydi. Noaniq nusxalarni private channel ichida qo‘lda tekshiring; avtomatik qayta nusxalash bajarilmadi.'
    )
    return
  }

  await reply(message, 'Noma’lum komanda. /help yuboring.')
}

async function processCallback(update: TelegramUpdate): Promise<void> {
  const callback = update.callback_query
  if (!callback) return
  const config = getConfig()
  const api = getTelegramService().getBotApiClient()
  if (!isAdminTelegramId(callback.from.id, config.adminTelegramIds)) {
    await api.answerCallbackQuery(callback.id, '⛔ Sizda admin ruxsati mavjud emas.')
    return
  }
  if (
    !callback.message ||
    callback.message.chat.type !== 'private' ||
    callback.message.chat.id !== callback.from.id
  ) {
    await api.answerCallbackQuery(callback.id, 'Private chatda tasdiqlang.')
    return
  }
  if (callback.data === 'del_cancel') {
    await api.answerCallbackQuery(callback.id, 'Bekor qilindi.')
    return
  }
  const match = /^del_confirm:(MED_[0-9A-F]{8})$/.exec(callback.data ?? '')
  if (!match) {
    await api.answerCallbackQuery(callback.id, 'Noma’lum amal.')
    return
  }
  const media = await getMediaById(match[1])
  if (!media || media.storageStatus !== 'stored' || media.storageMessageId === null) {
    await api.answerCallbackQuery(callback.id, 'Media topilmadi yoki saqlanmagan.')
    return
  }
  const deleted = await getTelegramService()
    .getStorageChannel()
    .deleteStorageMessage(media.storageMessageId)
  if (!deleted) {
    await api.answerCallbackQuery(
      callback.id,
      'Telegram xabarini o‘chirish muvaffaqiyatsiz tugadi.'
    )
    return
  }
  await softDeleteMedia(media.mediaId)
  await api.answerCallbackQuery(callback.id, 'Media o‘chirildi.')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>]/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!
  )
}

export async function processTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const updates = getCollection(COLLECTIONS.BOT_UPDATES)
  try {
    await updates.insertOne({
      updateId: update.update_id,
      status: 'processing',
      attempts: 1,
      createdAt: new Date(),
      processedAt: null,
      errorCode: null,
    })
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return
    throw error
  }

  try {
    const message = update.message
    if (message) {
      if (message.text?.trim().startsWith('/start')) {
        await processStart(message)
      } else if (message.text?.trim().startsWith('/')) {
        await processAdminCommand(message)
      } else {
        await processAdminUpload(message)
      }
    } else if (update.callback_query) {
      await processCallback(update)
    }
    await updates.updateOne(
      { updateId: update.update_id },
      { $set: { status: 'processed', processedAt: new Date(), errorCode: null } }
    )
  } catch (error) {
    await updates.updateOne(
      { updateId: update.update_id },
      {
        $set: {
          status: 'failed',
          processedAt: new Date(),
          errorCode: error instanceof TelegramApiError ? 'TELEGRAM_API_ERROR' : 'PROCESSING_ERROR',
        },
      }
    )
    throw error
  }
}
