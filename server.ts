import 'dotenv/config'

import express, {
  type Request,
  type Response,
} from 'express'

import cors from 'cors'

import { Bot } from 'grammy'

import {
  TelegramClient,
} from 'telegram'

import {
  StringSession,
} from 'telegram/sessions'

import bigInt from 'big-integer'

import fs from 'node:fs/promises'
import path from 'node:path'

// ======================================================
// CONFIG
// ======================================================

const TOKEN = process.env.TOKEN

const API_ID = Number(
  process.env.API_ID,
)

const API_HASH =
  process.env.API_HASH

const PORT =
  Number(process.env.PORT) || 3050

const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  `http://localhost:${PORT}`

// ======================================================
// CHECK ENV
// ======================================================

if (!TOKEN) {
  throw new Error(
    '❌ TOKEN topilmadi!',
  )
}

if (!API_ID) {
  throw new Error(
    '❌ API_ID topilmadi!',
  )
}

if (!API_HASH) {
  throw new Error(
    '❌ API_HASH topilmadi!',
  )
}

// ======================================================
// STORAGE
// ======================================================

const DATA_DIR =
  path.resolve('./data')

const MEDIA_FILE =
  path.join(
    DATA_DIR,
    'media.json',
  )

const SESSION_FILE =
  path.join(
    DATA_DIR,
    'session.txt',
  )

// ======================================================
// PERFORMANCE
// ======================================================

// Bitta cache chunk.
// 32 MB.
const CHUNK_SIZE =
  32 * 1024 * 1024

// Browser so'ragan chunkdan keyingi
// nechta chunkni oldindan yuklash.
const PREFETCH_CHUNKS = 3

// RAM cache maksimal hajmi.
// 1.5 GB.
const MAX_CACHE_SIZE =
  1536 * 1024 * 1024

// Telegram request chunk.
const TELEGRAM_REQUEST_SIZE =
  512 * 1024

// Bir vaqtning o'zida nechta
// Telegram download bo'lishi mumkin.
const MAX_PARALLEL_DOWNLOADS = 6

// ======================================================
// EXPRESS
// ======================================================

const app = express()

app.use(
  cors({
    origin: '*',

    methods: [
      'GET',
      'HEAD',
      'OPTIONS',
    ],

    allowedHeaders: [
      'Range',
      'Content-Type',
      'If-Range',
      'If-None-Match',
    ],

    exposedHeaders: [
      'Content-Length',
      'Content-Range',
      'Accept-Ranges',
      'Content-Type',
      'ETag',
      'Cache-Control',
      'Last-Modified',
    ],
  }),
)

app.use(
  express.json({
    limit: '1mb',
  }),
)

// ======================================================
// BOT
// ======================================================

const bot =
  new Bot(TOKEN)

// ======================================================
// TELEGRAM
// ======================================================

let savedSession = ''

try {
  savedSession =
    (
      await fs.readFile(
        SESSION_FILE,
        'utf8',
      )
    ).trim()
} catch {
  savedSession = ''
}

const session =
  new StringSession(
    savedSession,
  )

const client =
  new TelegramClient(
    session,
    API_ID,
    API_HASH,
    {
      connectionRetries: 10,
      requestRetries: 5,
    },
  )

// ======================================================
// TYPES
// ======================================================

type MediaType =
  | 'video'
  | 'photo'

type MediaRecord = {
  id: string

  fileId: string

  chatId: string

  messageId: number

  type: MediaType

  fileSize: number

  mimeType?: string

  fileName?: string

  width?: number

  height?: number

  duration?: number

  createdAt: string

  updatedAt: string
}

// ======================================================
// DATABASE
// ======================================================

const mediaDB =
  new Map<
    string,
    MediaRecord
  >()

// ======================================================
// DATABASE SAVE QUEUE
// ======================================================

let saveQueue =
  Promise.resolve()

// ======================================================
// PREPARE DATA
// ======================================================

async function prepareData() {
  await fs.mkdir(
    DATA_DIR,
    {
      recursive: true,
    },
  )

  try {
    await fs.access(
      MEDIA_FILE,
    )
  } catch {
    await fs.writeFile(
      MEDIA_FILE,
      '[]',
      'utf8',
    )
  }
}

// ======================================================
// LOAD DATABASE
// ======================================================

async function loadDatabase() {
  try {
    const raw =
      await fs.readFile(
        MEDIA_FILE,
        'utf8',
      )

    const records =
      JSON.parse(
        raw,
      ) as MediaRecord[]

    mediaDB.clear()

    for (
      const record of records
    ) {
      mediaDB.set(
        record.id,
        record,
      )
    }

    console.log(
      `💾 ${mediaDB.size} ta media yuklandi`,
    )
  } catch (error) {
    console.error(
      '❌ Media database error:',
      error,
    )
  }
}

// ======================================================
// SAVE DATABASE
// ======================================================

async function saveDatabase() {
  const records =
    Array.from(
      mediaDB.values(),
    )

  saveQueue =
    saveQueue.then(
      async () => {
        const temp =
          `${MEDIA_FILE}.tmp`

        await fs.writeFile(
          temp,
          JSON.stringify(
            records,
            null,
            2,
          ),
          'utf8',
        )

        await fs.rename(
          temp,
          MEDIA_FILE,
        )
      },
    )

  return saveQueue
}

// ======================================================
// ID
// ======================================================

function createMediaId() {
  return (
    Date.now().toString(36) +
    Math.random()
      .toString(36)
      .slice(2, 10)
  )
}

// ======================================================
// FIND MESSAGE
// ======================================================

function findByMessage(
  chatId: string,
  messageId: number,
) {
  for (
    const media of mediaDB.values()
  ) {
    if (
      media.chatId === chatId &&
      media.messageId === messageId
    ) {
      return media
    }
  }

  return undefined
}

// ======================================================
// FIND FILE ID
// ======================================================

function findByFileId(
  fileId: string,
) {
  for (
    const media of mediaDB.values()
  ) {
    if (
      media.fileId === fileId
    ) {
      return media
    }
  }

  return undefined
}

// ======================================================
// ======================================================
// RAM CACHE
// ======================================================
// ======================================================

type CacheEntry = {
  key: string

  mediaId: string

  chunkIndex: number

  start: number

  end: number

  data: Buffer

  size: number

  createdAt: number

  lastAccess: number
}

// ======================================================
// CACHE
// ======================================================

const cache =
  new Map<
    string,
    CacheEntry
  >()

let cacheSize = 0

// ======================================================
// CACHE KEY
// ======================================================

function createCacheKey(
  mediaId: string,
  chunkIndex: number,
) {
  return `${mediaId}:${chunkIndex}`
}

// ======================================================
// CACHE GET
// ======================================================

function getCache(
  key: string,
) {
  const entry =
    cache.get(key)

  if (!entry) {
    return undefined
  }

  entry.lastAccess =
    Date.now()

  // LRU uchun oxiriga ko'chiramiz.
  cache.delete(key)

  cache.set(
    key,
    entry,
  )

  return entry
}

// ======================================================
// CACHE DELETE
// ======================================================

function deleteCache(
  key: string,
) {
  const entry =
    cache.get(key)

  if (!entry) {
    return
  }

  cacheSize -=
    entry.size

  cache.delete(key)
}

// ======================================================
// CACHE CLEANUP
// ======================================================

function cleanupCache(
  requiredSize = 0,
) {
  while (
    cacheSize +
      requiredSize >
      MAX_CACHE_SIZE &&
    cache.size > 0
  ) {
    const first =
      cache.entries().next()
        .value as
        | [string, CacheEntry]
        | undefined

    if (!first) {
      break
    }

    const [
      key,
    ] = first

    deleteCache(key)
  }
}

// ======================================================
// CACHE SET
// ======================================================

function setCache(
  entry: CacheEntry,
) {
  cleanupCache(
    entry.size,
  )

  const old =
    cache.get(
      entry.key,
    )

  if (old) {
    cacheSize -=
      old.size
  }

  cache.delete(
    entry.key,
  )

  cache.set(
    entry.key,
    entry,
  )

  cacheSize +=
    entry.size
}

// ======================================================
// CACHE INFO
// ======================================================

function getCacheInfo() {
  return {
    entries:
      cache.size,

    bytes:
      cacheSize,

    mb:
      Number(
        (
          cacheSize /
          1024 /
          1024
        ).toFixed(2),
      ),

    maxMb:
      Number(
        (
          MAX_CACHE_SIZE /
          1024 /
          1024
        ).toFixed(2),
      ),
  }
}

// ======================================================
// DOWNLOAD LOCK
// ======================================================

// Bir chunk birinchi marta yuklanayotganda
// boshqa user yana shu chunkni so'rasa
// Telegramga ikkinchi request yubormaymiz.

const downloading =
  new Map<
    string,
    Promise<Buffer>
  >()

// ======================================================
// DOWNLOAD QUEUE
// ======================================================

let activeDownloads = 0

const waitingDownloads:
  Array<{
    task: () => void
  }> = []

function runDownloadTask(
  task: () => Promise<void>,
) {
  return new Promise<void>(
    (resolve, reject) => {
      const execute =
        async () => {
          activeDownloads++

          try {
            await task()

            resolve()
          } catch (error) {
            reject(error)
          } finally {
            activeDownloads--

            processDownloadQueue()
          }
        }

      if (
        activeDownloads <
        MAX_PARALLEL_DOWNLOADS
      ) {
        void execute()
      } else {
        waitingDownloads.push({
          task: execute,
        })
      }
    },
  )
}

function processDownloadQueue() {
  while (
    activeDownloads <
      MAX_PARALLEL_DOWNLOADS &&
    waitingDownloads.length >
      0
  ) {
    const item =
      waitingDownloads.shift()

    if (!item) {
      break
    }

    void item.task()
  }
}

// ======================================================
// TELEGRAM MESSAGE
// ======================================================

async function getTelegramMessage(
  media: MediaRecord,
) {
  const messages =
    await client.getMessages(
      media.chatId,
      {
        ids: [
          media.messageId,
        ],
      },
    )

  const message =
    messages[0]

  if (!message) {
    throw new Error(
      'Telegram message topilmadi',
    )
  }

  if (!message.media) {
    throw new Error(
      'Telegram media topilmadi',
    )
  }

  return message
}

// ======================================================
// MEDIA OBJECT CACHE
// ======================================================

// getMessages()ni har chunk uchun
// qayta-qayta chaqirmaslik uchun.

const telegramMediaCache =
  new Map<
    string,
    any
  >()

async function getTelegramMedia(
  media: MediaRecord,
) {
  const cached =
    telegramMediaCache.get(
      media.id,
    )

  if (cached) {
    return cached
  }

  const message =
    await getTelegramMessage(
      media,
    )

  const telegramMedia =
    message.media

  if (!telegramMedia) {
    throw new Error(
      'Telegram media yo‘q',
    )
  }

  telegramMediaCache.set(
    media.id,
    telegramMedia,
  )

  return telegramMedia
}

// ======================================================
// DOWNLOAD CHUNK
// ======================================================

async function downloadChunk(
  media: MediaRecord,
  chunkIndex: number,
): Promise<Buffer> {
  const key =
    createCacheKey(
      media.id,
      chunkIndex,
    )

  // ------------------------------------------
  // RAM CACHE
  // ------------------------------------------

  const cached =
    getCache(key)

  if (cached) {
    return cached.data
  }

  // ------------------------------------------
  // ALREADY DOWNLOADING
  // ------------------------------------------

  const existing =
    downloading.get(key)

  if (existing) {
    return existing
  }

  // ------------------------------------------
  // DOWNLOAD
  // ------------------------------------------

  const promise =
    (async () => {
      const start =
        chunkIndex *
        CHUNK_SIZE

      const end =
        Math.min(
          start +
            CHUNK_SIZE -
            1,
          media.fileSize -
            1,
        )

      if (
        start >=
        media.fileSize
      ) {
        return Buffer.alloc(0)
      }

      console.log(
        `⬇️ DOWNLOAD ${media.id} chunk=${chunkIndex} ${start}-${end}`,
      )

      const telegramMedia =
        await getTelegramMedia(
          media,
        )

      const length =
        end - start + 1

      const iterator =
        client.iterDownload({
          file:
            telegramMedia,

          offset:
            bigInt(start),

          limit:
            bigInt(length),

          fileSize:
            bigInt(
              media.fileSize,
            ),

          requestSize:
            TELEGRAM_REQUEST_SIZE,
        })

      const buffers:
        Buffer[] = []

      let total = 0

      for await (
        const chunk of iterator
      ) {
        const buffer =
          Buffer.from(chunk)

        if (
          buffer.length >
          0
        ) {
          buffers.push(
            buffer,
          )

          total +=
            buffer.length
        }
      }

      const result =
        Buffer.concat(
          buffers,
          total,
        )

      // ------------------------------------------
      // CACHE
      // ------------------------------------------

      setCache({
        key,

        mediaId:
          media.id,

        chunkIndex,

        start,

        end,

        data:
          result,

        size:
          result.length,

        createdAt:
          Date.now(),

        lastAccess:
          Date.now(),
      })

      console.log(
        `✅ CACHED ${media.id} chunk=${chunkIndex} ${result.length} bytes`,
      )

      return result
    })()

  downloading.set(
    key,
    promise,
  )

  try {
    return await promise
  } finally {
    downloading.delete(
      key,
    )
  }
}

// ======================================================
// QUEUED CHUNK
// ======================================================

async function getChunk(
  media: MediaRecord,
  chunkIndex: number,
) {
  const key =
    createCacheKey(
      media.id,
      chunkIndex,
    )

  const cached =
    getCache(key)

  if (cached) {
    return cached.data
  }

  let result:
    Buffer | undefined

  await runDownloadTask(
    async () => {
      result =
        await downloadChunk(
          media,
          chunkIndex,
        )
    },
  )

  return result || Buffer.alloc(0)
}

// ======================================================
// PREFETCH
// ======================================================

function prefetch(
  media: MediaRecord,
  currentChunk: number,
) {
  for (
    let i = 1;
    i <= PREFETCH_CHUNKS;
    i++
  ) {
    const chunkIndex =
      currentChunk + i

    const start =
      chunkIndex *
      CHUNK_SIZE

    if (
      start >=
      media.fileSize
    ) {
      break
    }

    const key =
      createCacheKey(
        media.id,
        chunkIndex,
      )

    if (
      cache.has(key) ||
      downloading.has(key)
    ) {
      continue
    }

    // Background download.
    void runDownloadTask(
      async () => {
        try {
          await downloadChunk(
            media,
            chunkIndex,
          )
        } catch (error) {
          console.error(
            `⚠️ Prefetch error chunk=${chunkIndex}`,
            error,
          )
        }
      },
    )
  }
}

// ======================================================
// RANGE PARSER
// ======================================================

function parseRange(
  range: string | undefined,
  totalSize: number,
) {
  if (!range) {
    return {
      start: 0,

      end:
        Math.min(
          totalSize - 1,
          CHUNK_SIZE - 1,
        ),
    }
  }

  const match =
    range.match(
      /^bytes=(\d+)-(\d*)$/,
    )

  if (!match) {
    return null
  }

  const start =
    Number(
      match[1],
    )

  let end =
    match[2]
      ? Number(
          match[2],
        )
      : start +
          CHUNK_SIZE -
          1

  if (
    !Number.isSafeInteger(
      start,
    ) ||
    !Number.isSafeInteger(
      end,
    )
  ) {
    return null
  }

  if (
    start < 0 ||
    start >= totalSize ||
    end < start
  ) {
    return null
  }

  end =
    Math.min(
      end,
      totalSize - 1,
    )

  return {
    start,
    end,
  }
}

// ======================================================
// STREAM FROM CACHE
// ======================================================

async function streamVideo(
  media: MediaRecord,
  start: number,
  end: number,
  req: Request,
  res: Response,
) {
  let position =
    start

  while (
    position <= end
  ) {
    if (
      req.destroyed ||
      res.destroyed
    ) {
      return
    }

    const chunkIndex =
      Math.floor(
        position /
          CHUNK_SIZE,
      )

    const chunkStart =
      chunkIndex *
      CHUNK_SIZE

    const chunk =
      await getChunk(
        media,
        chunkIndex,
      )

    if (
      chunk.length === 0
    ) {
      break
    }

    const from =
      Math.max(
        0,
        position -
          chunkStart,
      )

    const to =
      Math.min(
        chunk.length,
        end -
          chunkStart +
          1,
      )

    if (
      to <= from
    ) {
      break
    }

    const data =
      chunk.subarray(
        from,
        to,
      )

    const canContinue =
      res.write(data)

    position =
      chunkStart +
      to

    if (
      !canContinue
    ) {
      await new Promise<void>(
        (
          resolve,
        ) => {
          res.once(
            'drain',
            resolve,
          )
        },
      )
    }

    // Keyingi chunklarni
    // backgroundda olib kelamiz.
    if (
      position >
      chunkStart
    ) {
      prefetch(
        media,
        chunkIndex,
      )
    }
  }

  if (
    !res.destroyed &&
    !res.writableEnded
  ) {
    res.end()
  }
}

// ======================================================
// MEDIA LOG
// ======================================================

function logMedia(
  media: MediaRecord,
) {
  console.log('')

  console.log(
    '==========================================',
  )

  console.log(
    media.type === 'video'
      ? '🎬 VIDEO SAQLANDI'
      : '🖼 IMAGE SAQLANDI',
  )

  console.log(
    'ID:',
    media.id,
  )

  console.log(
    'File ID:',
    media.fileId,
  )

  console.log(
    'Chat:',
    media.chatId,
  )

  console.log(
    'Message:',
    media.messageId,
  )

  console.log(
    'Size:',
    media.fileSize,
  )

  console.log(
    'URL:',
    `${PUBLIC_URL}/api/${media.type}/${media.id}`,
  )

  console.log(
    '==========================================',
  )

  console.log('')
}

// ======================================================
// HOME
// ======================================================

app.get(
  '/',
  (
    _req,
    res,
  ) => {
    res.json({
      success: true,

      message:
        'Telegram Media API ishlayapti 🚀',

      telegram:
        client.connected,

      mediaCount:
        mediaDB.size,

      cache:
        getCacheInfo(),

      storage:
        'Telegram + RAM cache',
    })
  },
)

// ======================================================
// HEALTH
// ======================================================

app.get(
  '/health',
  (
    _req,
    res,
  ) => {
    res.json({
      success: true,

      telegram:
        client.connected,

      mediaCount:
        mediaDB.size,

      cache:
        getCacheInfo(),

      activeDownloads,

      maxParallelDownloads:
        MAX_PARALLEL_DOWNLOADS,

      uptime:
        process.uptime(),
    })
  },
)

// ======================================================
// MEDIA LIST
// ======================================================

app.get(
  '/api/media',
  (
    _req,
    res,
  ) => {
    return res.json({
      success: true,

      count:
        mediaDB.size,

      media:
        Array.from(
          mediaDB.values(),
        ),
    })
  },
)

// ======================================================
// MEDIA INFO
// ======================================================

app.get(
  '/api/media/:id',
  (
    req,
    res,
  ) => {
    const media =
      mediaDB.get(
        req.params.id,
      )

    if (!media) {
      return res
        .status(404)
        .json({
          success: false,

          message:
            'Media topilmadi',
        })
    }

    return res.json({
      success: true,

      media,

      url:
        `${PUBLIC_URL}/api/${media.type}/${media.id}`,
    })
  },
)

// ======================================================
// VIDEO
// ======================================================

app.get(
  '/api/video/:id',
  async (
    req,
    res,
  ) => {
    try {
      const media =
        mediaDB.get(
          req.params.id,
        )

      if (!media) {
        return res
          .status(404)
          .send(
            'Video topilmadi',
          )
      }

      if (
        media.type !==
        'video'
      ) {
        return res
          .status(400)
          .send(
            'Bu video emas',
          )
      }

      const totalSize =
        media.fileSize

      if (
        totalSize <= 0
      ) {
        return res
          .status(500)
          .send(
            'Video size noto‘g‘ri',
          )
      }

      const range =
        parseRange(
          req.headers.range,
          totalSize,
        )

      if (!range) {
        res.setHeader(
          'Content-Range',
          `bytes */${totalSize}`,
        )

        return res
          .status(416)
          .end()
      }

      const {
        start,
        end,
      } = range

      const length =
        end - start + 1

      // ==================================================
      // HEADERS
      // ==================================================

      res.status(206)

      res.setHeader(
        'Content-Type',
        media.mimeType ||
          'video/mp4',
      )

      res.setHeader(
        'Accept-Ranges',
        'bytes',
      )

      res.setHeader(
        'Content-Length',
        String(length),
      )

      res.setHeader(
        'Content-Range',
        `bytes ${start}-${end}/${totalSize}`,
      )

      res.setHeader(
        'Content-Disposition',
        'inline',
      )

      res.setHeader(
        'Cache-Control',
        'public, max-age=3600',
      )

      res.setHeader(
        'X-Content-Type-Options',
        'nosniff',
      )

      // ==================================================
      // DETERMINE CHUNK
      // ==================================================

      const chunkIndex =
        Math.floor(
          start /
            CHUNK_SIZE,
        )

      console.log('')

      console.log(
        '🎥 VIDEO',
      )

      console.log(
        'ID:',
        media.id,
      )

      console.log(
        `Range: ${start}-${end}`,
      )

      console.log(
        `Chunk: ${chunkIndex}`,
      )

      console.log(
        `Cache: ${getCacheInfo().mb} MB`,
      )

      // ==================================================
      // PREFETCH IMMEDIATELY
      // ==================================================

      prefetch(
        media,
        chunkIndex,
      )

      // ==================================================
      // STREAM
      // ==================================================

      await streamVideo(
        media,
        start,
        end,
        req,
        res,
      )
    } catch (error) {
      console.error(
        '❌ VIDEO ERROR:',
        error,
      )

      if (
        !res.headersSent
      ) {
        return res
          .status(500)
          .send(
            'Videoni yuklashda xato',
          )
      }

      if (
        !res.destroyed
      ) {
        res.destroy()
      }
    }
  },
)

// ======================================================
// VIDEO HEAD
// ======================================================

app.head(
  '/api/video/:id',
  (
    req,
    res,
  ) => {
    const media =
      mediaDB.get(
        req.params.id,
      )

    if (
      !media ||
      media.type !==
        'video'
    ) {
      return res
        .status(404)
        .end()
    }

    res.setHeader(
      'Content-Type',
      media.mimeType ||
        'video/mp4',
    )

    res.setHeader(
      'Content-Length',
      String(
        media.fileSize,
      ),
    )

    res.setHeader(
      'Accept-Ranges',
      'bytes',
    )

    res.setHeader(
      'Cache-Control',
      'public, max-age=3600',
    )

    return res
      .status(200)
      .end()
  },
)

// ======================================================
// IMAGE
// ======================================================

app.get(
  '/api/image/:id',
  async (
    req,
    res,
  ) => {
    try {
      const media =
        mediaDB.get(
          req.params.id,
        )

      if (!media) {
        return res
          .status(404)
          .send(
            'Rasm topilmadi',
          )
      }

      if (
        media.type !==
        'photo'
      ) {
        return res
          .status(400)
          .send(
            'Bu rasm emas',
          )
      }

      const telegramMedia =
        await getTelegramMedia(
          media,
        )

      const iterator =
        client.iterDownload({
          file:
            telegramMedia,

          requestSize:
            TELEGRAM_REQUEST_SIZE,
        })

      const chunks:
        Buffer[] = []

      let total = 0

      for await (
        const chunk of iterator
      ) {
        if (
          req.destroyed
        ) {
          return
        }

        const buffer =
          Buffer.from(chunk)

        chunks.push(
          buffer,
        )

        total +=
          buffer.length
      }

      const image =
        Buffer.concat(
          chunks,
          total,
        )

      res.setHeader(
        'Content-Type',
        media.mimeType ||
          'image/jpeg',
      )

      res.setHeader(
        'Content-Length',
        String(image.length),
      )

      res.setHeader(
        'Cache-Control',
        'public, max-age=86400',
      )

      res.setHeader(
        'X-Content-Type-Options',
        'nosniff',
      )

      return res.end(
        image,
      )
    } catch (error) {
      console.error(
        '❌ IMAGE ERROR:',
        error,
      )

      if (
        !res.headersSent
      ) {
        return res
          .status(500)
          .send(
            'Rasmni olishda xato',
          )
      }

      if (
        !res.destroyed
      ) {
        res.destroy()
      }
    }
  },
)

// ======================================================
// DELETE
// ======================================================

app.delete(
  '/api/media/:id',
  async (
    req,
    res,
  ) => {
    try {
      const id =
        req.params.id

      const media =
        mediaDB.get(id)

      if (!media) {
        return res
          .status(404)
          .json({
            success: false,

            message:
              'Media topilmadi',
          })
      }

      mediaDB.delete(id)

      // RAM cache'ni ham tozalaymiz.
      for (
        const [
          key,
          entry,
        ] of cache
      ) {
        if (
          entry.mediaId ===
          id
        ) {
          deleteCache(key)
        }
      }

      telegramMediaCache.delete(
        id,
      )

      await saveDatabase()

      return res.json({
        success: true,

        message:
          'Media o‘chirildi',
      })
    } catch (error) {
      console.error(
        '❌ DELETE ERROR:',
        error,
      )

      return res
        .status(500)
        .json({
          success: false,

          message:
            'O‘chirishda xato',
        })
    }
  },
)

// ======================================================
// TELEGRAM BOT
// ======================================================

bot.on(
  'message',
  async (
    ctx,
  ) => {
    try {
      const message =
        ctx.message

      const chatId =
        String(
          ctx.chat.id,
        )

      const messageId =
        message.message_id

      // ==================================================
      // VIDEO
      // ==================================================

      if (
        'video' in
        message
      ) {
        const video =
          message.video

        const existing =
          findByMessage(
            chatId,
            messageId,
          )

        if (existing) {
          await ctx.reply(
            `🎬 Video allaqachon mavjud!\n\n` +
              `🆔 ${existing.id}\n\n` +
              `🔗 ${PUBLIC_URL}/api/video/${existing.id}`,
          )

          return
        }

        const sameFile =
          findByFileId(
            video.file_id,
          )

        if (sameFile) {
          await ctx.reply(
            `🎬 Bu file_id allaqachon mavjud!\n\n` +
              `🆔 ${sameFile.id}`,
          )

          return
        }

        const id =
          createMediaId()

        const now =
          new Date().toISOString()

        const media:
          MediaRecord = {
          id,

          fileId:
            video.file_id,

          chatId,

          messageId,

          type: 'video',

          fileSize:
            video.file_size ??
            0,

          mimeType:
            video.mime_type ||
            'video/mp4',

          fileName:
            video.file_name,

          width:
            video.width,

          height:
            video.height,

          duration:
            video.duration,

          createdAt:
            now,

          updatedAt:
            now,
        }

        mediaDB.set(
          id,
          media,
        )

        await saveDatabase()

        logMedia(media)

        await ctx.reply(
          `🎬 VIDEO TAYYOR!\n\n` +
            `🆔 ${id}\n\n` +
            `🪪 File ID:\n${video.file_id}\n\n` +
            `📦 ${media.fileSize} bytes\n\n` +
            `🔗 ${PUBLIC_URL}/api/video/${id}`,
        )

        return
      }

      // ==================================================
      // DOCUMENT
      // ==================================================

      if (
        'document' in
        message
      ) {
        const document =
          message.document

        const mime =
          document.mime_type ||
          ''

        const fileName =
          document.file_name ||
          ''

        const isVideo =
          mime.startsWith(
            'video/',
          ) ||
          /\.(mp4|mkv|webm|mov|avi)$/i.test(
            fileName,
          )

        if (!isVideo) {
          await ctx.reply(
            '📦 Document video emas.',
          )

          return
        }

        const existing =
          findByMessage(
            chatId,
            messageId,
          )

        if (existing) {
          await ctx.reply(
            `🎬 Video mavjud!\n\n` +
              `🆔 ${existing.id}`,
          )

          return
        }

        const sameFile =
          findByFileId(
            document.file_id,
          )

        if (sameFile) {
          await ctx.reply(
            `🎬 Bu file_id allaqachon mavjud!\n\n` +
              `🆔 ${sameFile.id}`,
          )

          return
        }

        const id =
          createMediaId()

        const now =
          new Date().toISOString()

        const media:
          MediaRecord = {
          id,

          fileId:
            document.file_id,

          chatId,

          messageId,

          type: 'video',

          fileSize:
            document.file_size ??
            0,

          mimeType:
            mime ||
            'video/mp4',

          fileName,

          createdAt:
            now,

          updatedAt:
            now,
        }

        mediaDB.set(
          id,
          media,
        )

        await saveDatabase()

        logMedia(media)

        await ctx.reply(
          `🎬 VIDEO FILE TAYYOR!\n\n` +
            `🆔 ${id}\n\n` +
            `🪪 File ID:\n${document.file_id}\n\n` +
            `📁 ${fileName}\n\n` +
            `🔗 ${PUBLIC_URL}/api/video/${id}`,
        )

        return
      }

      // ==================================================
      // PHOTO
      // ==================================================

      if (
        'photo' in
        message
      ) {
        const photos =
          message.photo

        const photo =
          photos[
            photos.length - 1
          ]

        const existing =
          findByMessage(
            chatId,
            messageId,
          )

        if (existing) {
          await ctx.reply(
            `🖼 Rasm mavjud!\n\n` +
              `🆔 ${existing.id}`,
          )

          return
        }

        const sameFile =
          findByFileId(
            photo.file_id,
          )

        if (sameFile) {
          await ctx.reply(
            `🖼 Bu file_id allaqachon mavjud!\n\n` +
              `🆔 ${sameFile.id}`,
          )

          return
        }

        const id =
          createMediaId()

        const now =
          new Date().toISOString()

        const media:
          MediaRecord = {
          id,

          fileId:
            photo.file_id,

          chatId,

          messageId,

          type: 'photo',

          fileSize:
            photo.file_size ??
            0,

          width:
            photo.width,

          height:
            photo.height,

          createdAt:
            now,

          updatedAt:
            now,
        }

        mediaDB.set(
          id,
          media,
        )

        await saveDatabase()

        logMedia(media)

        await ctx.reply(
          `🖼 RASM TAYYOR!\n\n` +
            `🆔 ${id}\n\n` +
            `🪪 File ID:\n${photo.file_id}\n\n` +
            `🔗 ${PUBLIC_URL}/api/image/${id}`,
        )

        return
      }
    } catch (error) {
      console.error(
        '❌ BOT ERROR:',
        error,
      )
    }
  },
)

// ======================================================
// START
// ======================================================

async function start() {
  try {
    // ------------------------------------------
    // DATA
    // ------------------------------------------

    await prepareData()

    await loadDatabase()

    // ------------------------------------------
    // TELEGRAM
    // ------------------------------------------

    console.log('')

    console.log(
      '==========================================',
    )

    console.log(
      '🔌 TELEGRAM MTProto',
    )

    console.log(
      '==========================================',
    )

    await client.start({
      botAuthToken:
        TOKEN,
    })

    console.log(
      '✅ MTProto ulandi',
    )

    console.log(
      'Connected:',
      client.connected,
    )

    // ------------------------------------------
    // SAVE SESSION
    // ------------------------------------------

    const newSession =
      client.session.save()

    await fs.writeFile(
      SESSION_FILE,
      newSession,
      'utf8',
    )

    console.log(
      '💾 Session saqlandi',
    )

    // ------------------------------------------
    // EXPRESS
    // ------------------------------------------

    app.listen(
      PORT,
      '0.0.0.0',
      () => {
        console.log('')

        console.log(
          '==========================================',
        )

        console.log(
          '🚀 SERVER ISHLADI',
        )

        console.log(
          `📡 PORT: ${PORT}`,
        )

        console.log(
          `🌍 PUBLIC: ${PUBLIC_URL}`,
        )

        console.log(
          `💾 MEDIA: ${MEDIA_FILE}`,
        )

        console.log(
          `🧠 RAM CACHE: ${MAX_CACHE_SIZE / 1024 / 1024} MB`,
        )

        console.log(
          `📦 CHUNK: ${CHUNK_SIZE / 1024 / 1024} MB`,
        )

        console.log(
          `⚡ PREFETCH: ${PREFETCH_CHUNKS}`,
        )

        console.log(
          `🚀 PARALLEL: ${MAX_PARALLEL_DOWNLOADS}`,
        )

        console.log(
          '==========================================',
        )

        console.log('')
      },
    )

    // ------------------------------------------
    // BOT
    // ------------------------------------------

    bot.start()

    console.log(
      '🤖 BOT ISHLADI',
    )

    console.log(
      '🎬 Video/image yuborishingiz mumkin',
    )
  } catch (error) {
    console.error('')

    console.error(
      '❌ START ERROR',
    )

    console.error(
      error,
    )

    process.exit(1)
  }
}

// ======================================================
// RUN
// ======================================================

void start()
