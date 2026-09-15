import 'dotenv/config'

import bigInt from 'big-integer'
import cors from 'cors'
import express from 'express'
import { Bot } from 'grammy'
import { sessions, TelegramClient } from 'telegram'

// ======================================================
// CONFIG
// ======================================================

const TOKEN = process.env.TOKEN ?? ''

const API_ID = Number(process.env.API_ID)
const API_HASH = process.env.API_HASH

const PORT = Number(process.env.PORT) || 3050

const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '')

if (!TOKEN) {
  throw new Error('❌ TOKEN topilmadi!')
}

const BOT_TOKEN = TOKEN as string

if (!API_ID) {
  throw new Error('❌ API_ID topilmadi!')
}

if (!API_HASH) {
  throw new Error('❌ API_HASH topilmadi!')
}

// ======================================================
// PERFORMANCE CONFIG
// ======================================================

// Bitta chunk
const CHUNK_SIZE = 16 * 1024 * 1024 // 16 MB

// RAM cache maksimal hajmi
const MAX_CACHE_BYTES = 512 * 1024 * 1024 // 512 MB

// Bir vaqtning o'zida Telegram'dan nechta download
const MAX_TELEGRAM_DOWNLOADS = 2

// Telegram request chunk size
const TELEGRAM_REQUEST_SIZE = 1024 * 1024 // 1 MB

// Cache qancha vaqt saqlansin
const CACHE_TTL = 10 * 60 * 1000 // 10 min

// ======================================================
// EXPRESS
// ======================================================

const app = express()

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'HEAD', 'OPTIONS'],
  })
)

app.use(express.json())

// ======================================================
// GRAMMY
// ======================================================

const bot = new Bot(BOT_TOKEN)

// ======================================================
// TELEGRAM MTProto
// ======================================================

const session = new sessions.StringSession('')

const client = new TelegramClient(session, API_ID, API_HASH, {
  connectionRetries: 5,
})

// ======================================================
// TYPES
// ======================================================

type MediaType = 'video' | 'photo'

type MediaRecord = {
  id: string

  fileId: string

  chatId: string

  messageId: number

  type: MediaType

  fileSize: number

  mimeType?: string | undefined

  fileName?: string | undefined

  width?: number | undefined

  height?: number | undefined

  duration?: number | undefined
}

// ======================================================
// MEDIA DATABASE
// ======================================================

const mediaDB = new Map<string, MediaRecord>()

// ======================================================
// CACHE TYPES
// ======================================================

type CacheEntry = {
  key: string

  buffer: Buffer

  createdAt: number

  lastAccess: number

  size: number
}

const cache = new Map<string, CacheEntry>()

let cacheBytes = 0

// ======================================================
// ACTIVE DOWNLOADS
// ======================================================

// Bir xil chunkni 10 user so'rasa,
// Telegram'ga 10 ta request yubormaymiz.
//
// Bitta Promise ishlaydi va hamma shu Promise'ni kutadi.

const activeDownloads = new Map<string, Promise<Buffer>>()

// ======================================================
// DOWNLOAD QUEUE
// ======================================================

let activeTelegramDownloads = 0

const downloadQueue: Array<{
  task: () => Promise<void>
}> = []

// ======================================================
// ID
// ======================================================

function createMediaId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

// ======================================================
// CACHE SIZE
// ======================================================

function getCacheSizeMB() {
  return cacheBytes / 1024 / 1024
}

// ======================================================
// REMOVE CACHE
// ======================================================

function removeCache(key: string) {
  const entry = cache.get(key)

  if (!entry) {
    return
  }

  cacheBytes -= entry.size

  cache.delete(key)
}

// ======================================================
// CLEAN CACHE
// ======================================================

function cleanExpiredCache() {
  const now = Date.now()

  for (const [key, entry] of cache) {
    if (now - entry.createdAt > CACHE_TTL) {
      removeCache(key)
    }
  }
}

// ======================================================
// LRU CACHE
// ======================================================

function setCache(key: string, buffer: Buffer) {
  cleanExpiredCache()

  if (buffer.length > MAX_CACHE_BYTES) {
    return
  }

  // Agar mavjud bo'lsa
  removeCache(key)

  const entry: CacheEntry = {
    key,

    buffer,

    createdAt: Date.now(),

    lastAccess: Date.now(),

    size: buffer.length,
  }

  cache.set(key, entry)

  cacheBytes += buffer.length

  // Eng eski entry'larni o'chiramiz
  while (cacheBytes > MAX_CACHE_BYTES) {
    const first = cache.keys().next().value

    if (!first) {
      break
    }

    removeCache(first)
  }
}

// ======================================================
// GET CACHE
// ======================================================

function getCache(key: string) {
  cleanExpiredCache()

  const entry = cache.get(key)

  if (!entry) {
    return null
  }

  entry.lastAccess = Date.now()

  // LRU uchun oxiriga o'tkazamiz
  cache.delete(key)

  cache.set(key, entry)

  return entry.buffer
}

// ======================================================
// CACHE KEY
// ======================================================

function createChunkKey(mediaId: string, start: number) {
  return `${mediaId}:${start}`
}

// ======================================================
// DOWNLOAD QUEUE RUNNER
// ======================================================

function processDownloadQueue() {
  while (activeTelegramDownloads < MAX_TELEGRAM_DOWNLOADS && downloadQueue.length > 0) {
    const item = downloadQueue.shift()

    if (!item) {
      break
    }

    activeTelegramDownloads++

    item
      .task()
      .catch(() => {})
      .finally(() => {
        activeTelegramDownloads--

        processDownloadQueue()
      })
  }
}

// ======================================================
// QUEUE TELEGRAM DOWNLOAD
// ======================================================

function queueTelegramDownload(task: () => Promise<Buffer>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    downloadQueue.push({
      task: async () => {
        try {
          const result = await task()

          resolve(result)
        } catch (error) {
          reject(error)
        }
      },
    })

    processDownloadQueue()
  })
}

// ======================================================
// LOG MEDIA
// ======================================================

function logMedia(media: MediaRecord) {
  console.log('')

  console.log('======================================')

  console.log(media.type === 'video' ? '🎬 VIDEO SAQLANDI' : '🖼 PHOTO SAQLANDI')

  console.log('======================================')

  console.log('ID:', media.id)

  console.log('File ID:', media.fileId)

  console.log('Chat ID:', media.chatId)

  console.log('Message ID:', media.messageId)

  console.log('Size:', media.fileSize)

  console.log('Mime:', media.mimeType)

  console.log('File:', media.fileName)

  console.log('URL:', `${PUBLIC_URL}/api/${media.type}/${media.id}`)

  console.log('======================================')

  console.log('')
}

// ======================================================
// GET TELEGRAM MESSAGE
// ======================================================

async function getTelegramMessage(media: MediaRecord) {
  const messages = await client.getMessages(media.chatId, {
    ids: [media.messageId],
  })

  const message = messages[0]

  if (!message) {
    throw new Error('Telegram message topilmadi')
  }

  if (!message.media) {
    throw new Error('Telegram media topilmadi')
  }

  return message
}

// ======================================================
// DOWNLOAD ONE CHUNK
// ======================================================

async function downloadChunk(media: MediaRecord, start: number, end: number): Promise<Buffer> {
  const key = createChunkKey(media.id, start)

  // ====================================================
  // CACHE
  // ====================================================

  const cached = getCache(key)

  if (cached) {
    console.log(`⚡ CACHE HIT ${start}-${end}`)

    return cached
  }

  // ====================================================
  // ACTIVE DOWNLOAD
  // ====================================================

  const existing = activeDownloads.get(key)

  if (existing) {
    console.log(`⏳ WAIT EXISTING ${start}-${end}`)

    return existing
  }

  // ====================================================
  // DOWNLOAD
  // ====================================================

  const promise = queueTelegramDownload(async () => {
    console.log('')

    console.log(`⬇️ TELEGRAM CHUNK ${start}-${end}`)

    const message = await getTelegramMessage(media)

    const length = end - start + 1

    const chunks: Buffer[] = []

    let downloaded = 0

    const mediaFile = message.media

    if (!mediaFile) {
      throw new Error('Telegram media topilmadi')
    }

    const iterator = client.iterDownload({
      file: mediaFile,

      offset: bigInt(start),

      limit: length,

      fileSize: bigInt(media.fileSize),

      requestSize: TELEGRAM_REQUEST_SIZE,
    })

    for await (const chunk of iterator) {
      const buffer = Buffer.from(chunk)

      const remaining = length - downloaded

      if (remaining <= 0) {
        break
      }

      const data = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer

      chunks.push(data)

      downloaded += data.length

      if (downloaded >= length) {
        break
      }
    }

    const result = Buffer.concat(chunks)

    console.log(`✅ CHUNK ${start}-${end} → ${result.length} bytes`)

    // Cache
    setCache(key, result)

    return result
  })

  activeDownloads.set(key, promise)

  try {
    return await promise
  } finally {
    activeDownloads.delete(key)
  }
}

// ======================================================
// PREFETCH NEXT CHUNK
// ======================================================

function prefetchNextChunk(media: MediaRecord, currentStart: number) {
  const nextStart = currentStart + CHUNK_SIZE

  if (nextStart >= media.fileSize) {
    return
  }

  const nextEnd = Math.min(nextStart + CHUNK_SIZE - 1, media.fileSize - 1)

  const key = createChunkKey(media.id, nextStart)

  if (getCache(key) || activeDownloads.has(key)) {
    return
  }

  // Background download
  downloadChunk(media, nextStart, nextEnd).catch((error) => {
    console.error('⚠️ PREFETCH ERROR:', error?.message || error)
  })
}

// ======================================================
// HOME
// ======================================================

app.get('/', (_req, res) => {
  res.json({
    success: true,

    message: 'Telegram Media API ishlayapti 🚀',

    telegram: client.connected,

    mediaCount: mediaDB.size,

    cache: {
      entries: cache.size,

      bytes: cacheBytes,

      mb: Number(getCacheSizeMB().toFixed(2)),

      maxMb: MAX_CACHE_BYTES / 1024 / 1024,
    },

    activeDownloads: activeTelegramDownloads,

    queuedDownloads: downloadQueue.length,
  })
})

// ======================================================
// HEALTH
// ======================================================

app.get('/health', (_req, res) => {
  res.json({
    success: true,

    telegram: client.connected,

    mediaCount: mediaDB.size,

    cache: {
      entries: cache.size,

      bytes: cacheBytes,

      mb: Number(getCacheSizeMB().toFixed(2)),

      maxMb: MAX_CACHE_BYTES / 1024 / 1024,
    },

    activeDownloads: activeTelegramDownloads,

    queuedDownloads: downloadQueue.length,

    activeChunkDownloads: activeDownloads.size,

    uptime: process.uptime(),
  })
})

// ======================================================
// MEDIA LIST
// ======================================================

app.get('/api/media', (_req, res) => {
  return res.json({
    success: true,

    count: mediaDB.size,

    media: [...mediaDB.values()].map((media) => ({
      id: media.id,

      type: media.type,

      fileId: media.fileId,

      chatId: media.chatId,

      messageId: media.messageId,

      fileSize: media.fileSize,

      mimeType: media.mimeType,

      fileName: media.fileName,
    })),
  })
})

// ======================================================
// TELEGRAM MESSAGE RECEIVER
// ======================================================

bot.on('message', async (ctx) => {
  try {
    const message = ctx.message

    console.log('')

    console.log('======================================')

    console.log('📩 TELEGRAM MESSAGE')

    console.log('Chat ID:', ctx.chat.id)

    console.log('Message ID:', message.message_id)

    // ==================================================
    // VIDEO
    // ==================================================

    if ('video' in message) {
      const video = message.video

      const id = createMediaId()

      const media: MediaRecord = {
        id,

        fileId: video.file_id,

        chatId: String(ctx.chat.id),

        messageId: message.message_id,

        type: 'video',

        fileSize: video.file_size ?? 0,

        mimeType: video.mime_type || 'video/mp4',

        fileName: video.file_name ?? '',

        width: video.width,

        height: video.height,

        duration: video.duration,
      }

      mediaDB.set(id, media)

      logMedia(media)

      await ctx.reply(
        `🎬 VIDEO TAYYOR!\n\n` +
          `🆔 Media ID:\n${id}\n\n` +
          `📦 Hajmi:\n${media.fileSize} bytes\n\n` +
          `🎞 MIME:\n${media.mimeType}\n\n` +
          `🔗 Video URL:\n${PUBLIC_URL}/api/video/${id}`
      )

      return
    }

    // ==================================================
    // DOCUMENT VIDEO
    // ==================================================

    if ('document' in message) {
      const document = message.document

      const mime = document.mime_type || ''

      const fileName = document.file_name || ''

      const isVideo = mime.startsWith('video/') || /\.(mp4|mkv|webm|mov|avi)$/i.test(fileName)

      if (!isVideo) {
        await ctx.reply('📦 Document keldi, lekin video emas.')

        return
      }

      const id = createMediaId()

      const media: MediaRecord = {
        id,

        fileId: document.file_id,

        chatId: String(ctx.chat.id),

        messageId: message.message_id,

        type: 'video',

        fileSize: document.file_size ?? 0,

        mimeType: mime || 'video/mp4',

        fileName,
      }

      mediaDB.set(id, media)

      logMedia(media)

      await ctx.reply(
        `🎬 VIDEO FILE TAYYOR!\n\n` +
          `🆔 Media ID:\n${id}\n\n` +
          `📦 Hajmi:\n${media.fileSize} bytes\n\n` +
          `🎞 MIME:\n${media.mimeType}\n\n` +
          `📁 File:\n${media.fileName}\n\n` +
          `🔗 Video URL:\n${PUBLIC_URL}/api/video/${id}`
      )

      return
    }

    // ==================================================
    // PHOTO
    // ==================================================

    if ('photo' in message) {
      const photos = message.photo

      if (!photos || photos.length === 0) {
        throw new Error('Telegram photo topilmadi')
      }

      const photo = photos[photos.length - 1]

      if (!photo) {
        throw new Error('Telegram photo topilmadi')
      }

      const id = createMediaId()

      const media: MediaRecord = {
        id,

        fileId: photo.file_id,

        chatId: String(ctx.chat.id),

        messageId: message.message_id,

        type: 'photo',

        fileSize: photo.file_size ?? 0,

        width: photo.width,

        height: photo.height,
      }

      mediaDB.set(id, media)

      logMedia(media)

      await ctx.reply(
        `🖼 RASM TAYYOR!\n\n` +
          `🆔 Media ID:\n${id}\n\n` +
          `🔗 Image URL:\n${PUBLIC_URL}/api/image/${id}`
      )

      return
    }
  } catch (error) {
    console.error('❌ MESSAGE ERROR:', error)
  }
})

// ======================================================
// MEDIA INFO
// ======================================================

app.get('/api/media/:id', (req, res) => {
  const media = mediaDB.get(req.params.id)

  if (!media) {
    return res.status(404).json({
      success: false,

      message: 'Media topilmadi',
    })
  }

  return res.json({
    success: true,

    media,

    url: `${PUBLIC_URL}/api/${media.type}/${media.id}`,
  })
})

// ======================================================
// VIDEO
// ======================================================

app.get('/api/video/:id', async (req, res) => {
  try {
    const media = mediaDB.get(req.params.id)

    if (!media) {
      return res.status(404).send('Video topilmadi')
    }

    if (media.type !== 'video') {
      return res.status(400).send('Bu video emas')
    }

    const totalSize = Number(media.fileSize)

    if (!Number.isFinite(totalSize) || totalSize <= 0) {
      return res.status(500).send('Video hajmi noto‘g‘ri')
    }

    const range = req.headers.range

    let start = 0

    let end = Math.min(CHUNK_SIZE - 1, totalSize - 1)

    // ==================================================
    // RANGE
    // ==================================================

    if (range) {
      const match = range.match(/^bytes=(\d+)-(\d*)$/)

      if (!match) {
        res.setHeader('Content-Range', `bytes */${totalSize}`)

        return res.status(416).end()
      }

      start = Number(match[1])

      if (match[2]) {
        end = Number(match[2])
      } else {
        end = Math.min(
          start + CHUNK_SIZE - 1,

          totalSize - 1
        )
      }

      if (start < 0 || start >= totalSize || start > end) {
        res.setHeader('Content-Range', `bytes */${totalSize}`)

        return res.status(416).end()
      }

      end = Math.min(end, totalSize - 1)
    }

    // ==================================================
    // LIMIT RANGE
    // ==================================================

    // Browser juda katta range so'rasa,
    // faqat CHUNK_SIZE yuboramiz.

    if (end - start + 1 > CHUNK_SIZE) {
      end = start + CHUNK_SIZE - 1

      end = Math.min(end, totalSize - 1)
    }

    // ==================================================
    // CHUNK ALIGNMENT
    // ==================================================

    const chunkStart = Math.floor(start / CHUNK_SIZE) * CHUNK_SIZE

    const chunkEnd = Math.min(
      chunkStart + CHUNK_SIZE - 1,

      totalSize - 1
    )

    console.log('')

    console.log('======================================')

    console.log('🎥 VIDEO REQUEST')

    console.log('ID:', media.id)

    console.log('Requested:', `${start}-${end}`)

    console.log('Chunk:', `${chunkStart}-${chunkEnd}`)

    console.log('Range:', range || 'none')

    // ==================================================
    // GET CHUNK
    // ==================================================

    const chunk = await downloadChunk(media, chunkStart, chunkEnd)

    if (!chunk || chunk.length === 0) {
      return res.status(500).send('Video chunk bo‘sh')
    }

    // ==================================================
    // SLICE REQUEST
    // ==================================================

    const relativeStart = start - chunkStart

    const relativeEnd = Math.min(end - chunkStart, chunk.length - 1)

    if (relativeStart < 0 || relativeStart >= chunk.length) {
      return res.status(500).send('Chunk range xatosi')
    }

    const data = chunk.subarray(relativeStart, relativeEnd + 1)

    // ==================================================
    // HEADERS
    // ==================================================

    res.status(range ? 206 : 200)

    res.setHeader('Content-Type', media.mimeType || 'video/mp4')

    res.setHeader('Accept-Ranges', 'bytes')

    res.setHeader('Content-Length', String(data.length))

    res.setHeader('Content-Range', `bytes ${start}-${start + data.length - 1}/${totalSize}`)

    res.setHeader('Content-Disposition', 'inline')

    res.setHeader('Cache-Control', 'public, max-age=3600')

    res.setHeader('X-Cache-Size', `${getCacheSizeMB().toFixed(2)}MB`)

    // ==================================================
    // SEND
    // ==================================================

    res.end(data)

    // ==================================================
    // PREFETCH
    // ==================================================

    prefetchNextChunk(media, chunkStart)

    console.log(`⚡ SENT ${data.length} bytes`)

    console.log('======================================')

    console.log('')
  } catch (error) {
    console.error('')

    console.error('❌ VIDEO ERROR')

    console.error(error)

    console.error('')

    if (!res.headersSent) {
      return res.status(500).send('Videoni stream qilishda xato')
    }

    if (!res.destroyed) {
      res.destroy()
    }
  }
})

// ======================================================
// IMAGE
// ======================================================

app.get('/api/image/:id', async (req, res) => {
  try {
    const media = mediaDB.get(req.params.id)

    if (!media) {
      return res.status(404).send('Rasm topilmadi')
    }

    if (media.type !== 'photo') {
      return res.status(400).send('Bu rasm emas')
    }

    const message = await getTelegramMessage(media)

    const chunks: Buffer[] = []

    if (!message.media) {
      throw new Error('Telegram media topilmadi')
    }

    const iterator = client.iterDownload({
      file: message.media,

      requestSize: TELEGRAM_REQUEST_SIZE,
    })

    for await (const chunk of iterator) {
      chunks.push(Buffer.from(chunk))
    }

    const buffer = Buffer.concat(chunks)

    res.setHeader('Content-Type', media.mimeType || 'image/jpeg')

    res.setHeader('Content-Length', String(buffer.length))

    res.setHeader('Cache-Control', 'public, max-age=3600')

    return res.end(buffer)
  } catch (error) {
    console.error('❌ IMAGE ERROR:', error)

    if (!res.headersSent) {
      return res.status(500).send('Rasmni olishda xato')
    }

    res.destroy()
  }
})

// ======================================================
// START
// ======================================================

async function start() {
  try {
    console.log('')

    console.log('======================================')

    console.log('🔌 TELEGRAM MTProto')

    console.log('======================================')

    await client.start({
      botAuthToken: BOT_TOKEN,
    })

    console.log('✅ MTProto ulandi!')

    console.log('Telegram connected:', client.connected)

    // ==================================================
    // EXPRESS
    // ==================================================

    app.listen(PORT, '0.0.0.0', () => {
      console.log('')

      console.log('======================================')

      console.log(`🚀 API: ${PUBLIC_URL}`)

      console.log(`🚀 PORT: ${PORT}`)

      console.log(`⚡ Chunk: ${CHUNK_SIZE / 1024 / 1024} MB`)

      console.log(`💾 Cache: ${MAX_CACHE_BYTES / 1024 / 1024} MB`)

      console.log(`🔄 Telegram parallel: ${MAX_TELEGRAM_DOWNLOADS}`)

      console.log('======================================')

      console.log('')
    })

    // ==================================================
    // BOT
    // ==================================================

    bot.start()

    console.log('🤖 BOT ISHLADI!')

    console.log('🎬 Video yuborishingiz mumkin.')
  } catch (error) {
    console.error('')

    console.error('❌ SERVER ERROR')

    console.error(error)

    console.error('')

    process.exit(1)
  }
}

// ======================================================
// RUN
// ======================================================

start()
