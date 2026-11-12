import { COLLECTIONS } from '../../config/constants.js'
import { getConfig } from '../../config/env.js'
import { TelegramApiError } from '../../core/errors/app-error.js'
import type { TelegramMessage, TelegramUpdate } from '../../core/types/index.js'
import { formatDuration, formatFileSize } from '../../core/utils/index.js'
import { logger } from '../../infrastructure/logger/logger.js'
import { getCollection } from '../../infrastructure/mongodb/client.js'
import { getTelegramService } from '../../infrastructure/telegram/telegram.service.js'
import {
  consumeDeleteConfirmation,
  createDeleteConfirmation,
} from '../admin/admin-action.repository.js'
import { isAdminTelegramId } from '../admin/admin.service.js'
import { recordAdminAudit } from '../admin/audit.repository.js'
import { getTelegramMediaMetadata, isSupportedTelegramMediaMessage } from '../media/media-id.js'
import {
  createMediaRecord,
  getMediaById,
  getMediaBySourceMessage,
  setMediaVisibility,
  softDeleteMedia,
  updateMediaStorage,
} from '../media/media.service.js'
import { buildWatchPageUrl, canPreviewMedia } from '../preview/preview.service.js'
import { WatchTokenRepository } from '../watch/watch-token.repository.js'
import {
  createWatchTokenData,
  hashWatchToken,
  isWatchTokenUsable,
  parseWatchStartPayload,
} from '../watch/watch-token.service.js'
import type { DashboardView } from './bot.dashboard.js'
import {
  callbackData,
  renderDashboard,
  renderHelp,
  renderLibrary,
  renderMediaDetails,
  renderMonitor,
  renderSettings,
  renderStatistics,
  renderUploadPrompt,
} from './bot.dashboard.js'
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
    if (!isAdminTelegramId(userId, config.adminTelegramIds)) {
      await recordAdminAudit({
        eventType: 'admin.access_denied',
        adminTelegramId: userId,
        result: 'denied',
      })
      await reply(message, '⛔ Sizda administrator ruxsati mavjud emas.')
      return
    }
    await recordAdminAudit({
      eventType: 'admin.dashboard_opened',
      adminTelegramId: userId,
      result: 'success',
    })
    const dashboard = await renderDashboard()
    await getTelegramService().getBotApiClient().sendMessage(message.chat.id, dashboard.text, {
      parse_mode: 'HTML',
      reply_markup: dashboard.reply_markup,
      disable_web_page_preview: true,
    })
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
    if (userId) {
      await recordAdminAudit({
        eventType: 'media.upload_denied',
        adminTelegramId: userId,
        result: 'denied',
      })
    }
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
    await recordAdminAudit({
      eventType: 'media.upload_failed',
      adminTelegramId: userId,
      mediaId: media.mediaId,
      result: 'failure',
    })
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
  await recordAdminAudit({
    eventType: 'media.upload_stored',
    adminTelegramId: userId,
    mediaId: media.mediaId,
    result: 'success',
  })

  try {
    const token = createWatchTokenData({
      mediaId: media.mediaId,
      expiresAt: new Date(Date.now() + config.watchTokenTtlSeconds * 1000),
      maxUses: config.maxWatchTokenUses,
    })
    await watchTokens.create({ ...token, usedCount: 0 })

    const webPreviewUrl =
      canPreviewMedia(metadata.sizeBytes, config.botApiDownloadMaxBytes) && config.publicApiUrl
        ? buildWatchPageUrl(config.publicApiUrl, media.mediaId, token.token)
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
    if (userId) {
      await recordAdminAudit({
        eventType: 'admin.command_denied',
        adminTelegramId: userId,
        result: 'denied',
      })
    }
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
    const previewSize = media.sizeBytes
    if (!canPreviewMedia(previewSize, config.botApiDownloadMaxBytes)) {
      await reply(
        message,
        `Web preview faqat ${formatFileSize(config.botApiDownloadMaxBytes)} gacha bo‘lishi kerak. Bu media hajmi katta.`
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
    const previewUrl = buildWatchPageUrl(config.publicApiUrl, media.mediaId, token.token)
    if (!previewUrl) {
      await reply(message, 'Watch URL yaratilmadi: PUBLIC_API_URL sozlanmagan.')
      return
    }
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
    await recordAdminAudit({
      eventType: 'media.visibility_changed',
      adminTelegramId: userId,
      mediaId,
      result: changed ? 'success' : 'failure',
    })
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
    const confirmation = await createDeleteConfirmation(media.mediaId, userId)
    await api.sendMessage(
      message.chat.id,
      `⚠️ <b>MEDIA’NI O‘CHIRISH</b>\n\nHaqiqatan ham <b>${escapeHtml(media.fileName ?? media.mediaId)}</b> ni XENVO storage’dan o‘chirmoqchimisiz?\n\nAsl upload xabari Telegram’da o‘chirilmaydi.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🗑 Ha, o‘chirish', callback_data: callbackData(`delete:${confirmation}`) },
              { text: '❌ Bekor qilish', callback_data: 'delete:cancel' },
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
    await recordAdminAudit({
      eventType: 'admin.callback_denied',
      adminTelegramId: callback.from.id,
      result: 'denied',
    })
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
  const data = callback.data ?? ''
  if (Buffer.byteLength(data, 'utf8') > 64) {
    await api.answerCallbackQuery(callback.id, 'Amal kodi noto‘g‘ri.')
    return
  }
  await api.answerCallbackQuery(callback.id)

  const showView = async (view: {
    text: DashboardView['text']
    reply_markup: DashboardView['reply_markup']
  }): Promise<void> => {
    try {
      await api.editMessageText(
        callback.message!.chat.id,
        callback.message!.message_id,
        view.text,
        {
          parse_mode: 'HTML',
          reply_markup: view.reply_markup,
          disable_web_page_preview: true,
        }
      )
    } catch {
      await api.sendMessage(callback.message!.chat.id, view.text, {
        parse_mode: 'HTML',
        reply_markup: view.reply_markup,
        disable_web_page_preview: true,
      })
    }
  }

  try {
    if (data === 'menu:home') return showView(await renderDashboard())
    if (data === 'menu:upload') return showView(renderUploadPrompt())
    if (data === 'menu:stats') return showView(await renderStatistics())
    if (data === 'menu:monitor') return showView(await renderMonitor())
    if (data === 'menu:help') return showView(renderHelp())
    if (data === 'menu:settings') return showView(renderSettings())
    if (data === 'library:search') {
      await api.sendMessage(
        callback.message.chat.id,
        '🔎 <b>MEDIA QIDIRISH</b>\n\nQidirish uchun <code>/search QUERY</code> yuboring. Media ID yoki fayl nomi bilan izlash mumkin.',
        { parse_mode: 'HTML' }
      )
      return
    }

    const libraryMatch =
      /^library:(\d{1,6}):(all|video|photo|audio|document|processing|failed|public|private)$/.exec(
        data
      )
    if (libraryMatch) {
      return showView(await renderLibrary(Number(libraryMatch[1]), libraryMatch[2]))
    }

    const mediaMatch = /^media:(detail|delete|preview|publish|unpublish):(MED_[0-9A-F]{8})$/.exec(
      data
    )
    if (mediaMatch?.[1] === 'detail') {
      const media = await getMediaById(mediaMatch[2])
      if (!media) {
        await api.sendMessage(callback.message.chat.id, 'Media topilmadi yoki o‘chirilgan.')
        return
      }
      return showView(renderMediaDetails(media))
    }

    if (mediaMatch?.[1] === 'publish' || mediaMatch?.[1] === 'unpublish') {
      const visibility = mediaMatch[1] === 'publish' ? 'public' : 'private'
      const changed = await setMediaVisibility(mediaMatch[2], visibility)
      const media = changed ? await getMediaById(mediaMatch[2]) : null
      if (!media) {
        await api.sendMessage(
          callback.message.chat.id,
          'Саqlangan media topilmadi ёки status ўзгармади.'
        )
        return
      }
      await recordAdminAudit({
        eventType: 'media.visibility_changed',
        adminTelegramId: callback.from.id,
        mediaId: media.mediaId,
        result: 'success',
      })
      return showView(renderMediaDetails(media))
    }

    if (mediaMatch?.[1] === 'delete') {
      const media = await getMediaById(mediaMatch[2])
      if (!media || media.storageStatus !== 'stored' || media.storageMessageId === null) {
        await api.sendMessage(callback.message.chat.id, 'Saqlangan media topilmadi.')
        return
      }
      const confirmation = await createDeleteConfirmation(media.mediaId, callback.from.id)
      await api.editMessageText(
        callback.message.chat.id,
        callback.message.message_id,
        `⚠️ <b>MEDIA’NI O‘CHIRISH</b>\n\n${escapeHtml(media.fileName ?? media.mediaId)}\n\nStorage nusxasi o‘chiriladi. Asl upload xabari Telegram’da qoladi.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🗑 Tasdiqlash', callback_data: callbackData(`delete:${confirmation}`) },
                { text: '❌ Bekor qilish', callback_data: 'delete:cancel' },
              ],
            ],
          },
        }
      )
      return
    }

    if (mediaMatch?.[1] === 'preview') {
      const media = await getMediaById(mediaMatch[2])
      if (!media || media.storageStatus !== 'stored' || media.storageMessageId === null) {
        await api.sendMessage(callback.message.chat.id, 'Saqlangan media topilmadi.')
        return
      }
      const localBotApiConfigured = config.telegramApiBaseUrl !== 'https://api.telegram.org'
      if (!canPreviewMedia(media.sizeBytes, config.botApiDownloadMaxBytes, localBotApiConfigured)) {
        await api.sendMessage(
          callback.message.chat.id,
          'Streaming uchun media hajmi yoki Local Bot API konfiguratsiyasi tayyor emas.'
        )
        return
      }
      if (!config.publicApiUrl) {
        await api.sendMessage(callback.message.chat.id, 'PUBLIC_API_URL sozlanmagan.')
        return
      }
      const token = createWatchTokenData({
        mediaId: media.mediaId,
        expiresAt: new Date(Date.now() + config.watchTokenTtlSeconds * 1000),
        maxUses: config.maxWatchTokenUses,
      })
      await watchTokens.create({ ...token, usedCount: 0 })
      const previewUrl = buildWatchPageUrl(config.publicApiUrl, media.mediaId, token.token)
      if (!previewUrl) {
        await api.sendMessage(callback.message.chat.id, 'Watch URL yaratilmadi.')
        return
      }
      await api.sendMessage(
        callback.message.chat.id,
        `🌐 ${escapeHtml(media.fileName ?? media.mediaId)} үшін XENVO streaming link (${Math.floor(config.watchTokenTtlSeconds / 60)} daqiqa amal qiladi):`,
        { reply_markup: { inline_keyboard: [[{ text: '🌐 XENVO’da ochish', url: previewUrl }]] } }
      )
      return
    }

    if (data === 'delete:cancel') {
      await api.editMessageText(
        callback.message.chat.id,
        callback.message.message_id,
        'O‘chirish bekor qilindi.',
        {
          reply_markup: {
            inline_keyboard: [[{ text: '🏠 Asosiy menyu', callback_data: 'menu:home' }]],
          },
        }
      )
      return
    }

    const deleteMatch = /^delete:([A-Za-z0-9_-]{20,30})$/.exec(data)
    if (!deleteMatch) {
      await api.sendMessage(callback.message.chat.id, 'Amal yaroqsiz yoki muddati tugagan.')
      return
    }
    const mediaId = await consumeDeleteConfirmation(deleteMatch[1], callback.from.id)
    if (!mediaId) {
      await api.sendMessage(
        callback.message.chat.id,
        'Tasdiqlash muddati tugagan yoki amal bajarilgan.'
      )
      return
    }
    const media = await getMediaById(mediaId)
    if (!media || media.storageStatus !== 'stored' || media.storageMessageId === null) {
      await api.sendMessage(callback.message.chat.id, 'Media topilmadi ёки саqlanmagan.')
      return
    }
    const deleted = await getTelegramService()
      .getStorageChannel()
      .deleteStorageMessage(media.storageMessageId)
    if (!deleted) {
      await recordAdminAudit({
        eventType: 'media.delete_failed',
        adminTelegramId: callback.from.id,
        mediaId,
        result: 'failure',
      })
      await api.sendMessage(
        callback.message.chat.id,
        'Storage nusxasini Telegram’dan o‘chirib bo‘lmadi.'
      )
      return
    }
    await softDeleteMedia(media.mediaId)
    await recordAdminAudit({
      eventType: 'media.deleted',
      adminTelegramId: callback.from.id,
      mediaId: media.mediaId,
      result: 'success',
    })
    await api.editMessageText(
      callback.message.chat.id,
      callback.message.message_id,
      `✅ <b>${escapeHtml(media.fileName ?? media.mediaId)}</b> XENVO’dan o‘chirildi. Asl upload xabari Telegram’da qoldi.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🏠 Asosiy menyu', callback_data: 'menu:home' }]],
        },
      }
    )
  } catch (error) {
    logger.error({ adminTelegramId: callback.from.id, error }, 'Admin callback failed')
    await api.sendMessage(
      callback.message.chat.id,
      'Amal bajarilmadi. Holatni tekshirib qayta urinib ko‘ring.'
    )
  }
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
