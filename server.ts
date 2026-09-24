import "dotenv/config";

import bigInt from "big-integer";
import compression from "compression";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { Bot } from "grammy";
import pino from "pino";
import { sessions, TelegramClient } from "telegram";

// ============================================================
// LOGGER SETUP
// ============================================================

const logger = pino.default({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      singleLine: false,
      translateTime: "SYS:standard",
    },
  },
});

// ============================================================
// CONFIG
// ============================================================

interface Config {
  token: string;
  apiId: number;
  apiHash: string;
  port: number;
  publicUrl: string;
  adminIds: number[];
}

function loadConfig(): Config {
  const token = process.env.TOKEN ?? "";
  const apiId = Number(process.env.API_ID);
  const apiHash = process.env.API_HASH;
  const port = Number(process.env.PORT) || 3050;
  const publicUrl = (
    process.env.PUBLIC_URL || `http://localhost:${port}`
  ).replace(/\/+$/, "");
  const adminIds = (process.env.ADMIN_IDS || process.env.ADMIN_ID || "")
    .split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id));

  if (!token) throw new Error("❌ TOKEN not found");
  if (!apiId) throw new Error("❌ API_ID not found");
  if (!apiHash) throw new Error("❌ API_HASH not found");

  return { token, apiId, apiHash, port, publicUrl, adminIds };
}

const config = loadConfig();

function isAdminChat(chatId: string | number): boolean {
  if (config.adminIds.length === 0) return true;
  return config.adminIds.includes(Number(chatId));
}

function createMediaButtons(mediaUrl: string) {
  return {
    inline_keyboard: [
      [
        {
          text: "👁 Tomosha qilish",
          url: mediaUrl,
        },
        {
          text: "📋 Linkni nusxalash",
          url: `https://t.me/share/url?url=${encodeURIComponent(mediaUrl)}`,
        },
      ],
    ],
  };
}

// ============================================================
// PERFORMANCE CONFIG
// ============================================================

const PERFORMANCE = {
  // Katta chunk size = kam request va tezlik ⚡
  CHUNK_SIZE: 128 * 1024 * 1024, // 128 MB (2x tez)

  // RAM cache maksimal (oshirildi)
  MAX_CACHE_BYTES: 4 * 1024 * 1024 * 1024, // 4 GB (2x)

  // Parallel Telegram downloads (oshirildi)
  MAX_TELEGRAM_DOWNLOADS: 16, // 2x parallel

  // Har bitta Telegram request'da nechta data (oshirildi)
  TELEGRAM_REQUEST_SIZE: 32 * 1024 * 1024, // 32 MB (2x)

  // Cache qancha vaqt saqlansin
  CACHE_TTL: 60 * 60 * 1000, // 60 min (uzunroq)

  // Prefetch strategy (oshirildi)
  PREFETCH_CHUNKS: 5, // Ko'proq prefetch

  // Request timeout
  REQUEST_TIMEOUT: 60 * 1000, // 60 sec

  // Max video size
  MAX_VIDEO_SIZE: 10 * 1024 * 1024 * 1024, // 10 GB (2x)

  // Rate limit (oshirildi)
  RATE_LIMIT_WINDOW: 60 * 1000, // 1 min
  RATE_LIMIT_MAX_REQUESTS: 5000, // 5x ko'proq
} as const;

// ============================================================
// TYPES
// ============================================================

type MediaType = "video" | "photo";

interface MediaRecord {
  id: string;
  fileId: string;
  chatId: string;
  messageId: number;
  type: MediaType;
  fileSize: number;
  mimeType?: string;
  fileName?: string;
  width?: number;
  height?: number;
  duration?: number;
  createdAt: number;
  accessCount: number;
}

interface CacheEntry {
  key: string;
  buffer: Buffer;
  createdAt: number;
  lastAccess: number;
  size: number;
}

interface DownloadTask {
  mediaId: string;
  chunkStart: number;
  chunkEnd: number;
  priority: number;
  retries: number;
}

// ============================================================
// STATE MANAGEMENT
// ============================================================

class StateManager {
  private mediaDB = new Map<string, MediaRecord>();
  private cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  private activeDownloads = new Map<string, Promise<Buffer>>();
  private downloadQueue: DownloadTask[] = [];
  private activeTelegramDownloads = 0;
  private requestMetrics = new Map<string, number>();

  // Lock uchun
  private queueLock = false;

  // Getters
  getMedia(id: string): MediaRecord | undefined {
    const media = this.mediaDB.get(id);
    if (media) {
      media.accessCount++;
      media.accessCount; // Update stats
    }
    return media;
  }

  getAllMedia(): MediaRecord[] {
    return Array.from(this.mediaDB.values());
  }

  getCacheSizeMB(): number {
    return this.cacheBytes / 1024 / 1024;
  }

  getStats() {
    return {
      mediaCount: this.mediaDB.size,
      cacheEntries: this.cache.size,
      cacheBytes: this.cacheBytes,
      cacheMB: Number(this.getCacheSizeMB().toFixed(2)),
      activeTelegramDownloads: this.activeTelegramDownloads,
      queuedDownloads: this.downloadQueue.length,
      activeChunkDownloads: this.activeDownloads.size,
    };
  }

  // Media operations
  addMedia(media: MediaRecord): void {
    this.mediaDB.set(media.id, media);
  }

  // Cache operations
  getCache(key: string): Buffer | null {
    this.cleanExpiredCache();

    const entry = this.cache.get(key);
    if (!entry) return null;

    entry.lastAccess = Date.now();

    // LRU: Move to end
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.buffer;
  }

  setCache(key: string, buffer: Buffer): void {
    this.cleanExpiredCache();

    if (buffer.length > PERFORMANCE.MAX_CACHE_BYTES) {
      logger.warn(`Buffer too large to cache: ${buffer.length} bytes`);
      return;
    }

    // Remove existing
    this.removeCache(key);

    const entry: CacheEntry = {
      key,
      buffer,
      createdAt: Date.now(),
      lastAccess: Date.now(),
      size: buffer.length,
    };

    this.cache.set(key, entry);
    this.cacheBytes += buffer.length;

    // Remove oldest entries if exceeded
    while (this.cacheBytes > PERFORMANCE.MAX_CACHE_BYTES) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      this.removeCache(oldestKey);
    }
  }

  private removeCache(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;

    this.cacheBytes -= entry.size;
    this.cache.delete(key);
  }

  private cleanExpiredCache(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > PERFORMANCE.CACHE_TTL) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach((key) => this.removeCache(key));
  }

  // Download tracking
  hasActiveDownload(key: string): boolean {
    return this.activeDownloads.has(key);
  }

  getActiveDownload(key: string): Promise<Buffer> | undefined {
    return this.activeDownloads.get(key);
  }

  setActiveDownload(key: string, promise: Promise<Buffer>): void {
    this.activeDownloads.set(key, promise);
  }

  deleteActiveDownload(key: string): void {
    this.activeDownloads.delete(key);
  }

  // Queue management with lock
  async queueDownload(task: DownloadTask): Promise<void> {
    this.downloadQueue.push(task);
    this.downloadQueue.sort((a, b) => b.priority - a.priority);
    await this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.queueLock) return;

    this.queueLock = true;

    try {
      while (
        this.activeTelegramDownloads < PERFORMANCE.MAX_TELEGRAM_DOWNLOADS &&
        this.downloadQueue.length > 0
      ) {
        this.activeTelegramDownloads++;
        const task = this.downloadQueue.shift();

        if (!task) {
          this.activeTelegramDownloads--;
          break;
        }

        // Task will be processed externally
        // Just mark as active
      }
    } finally {
      this.queueLock = false;
    }
  }

  incrementActiveTelegramDownloads(): void {
    this.activeTelegramDownloads++;
  }

  decrementActiveTelegramDownloads(): void {
    this.activeTelegramDownloads--;
  }

  // Metrics
  recordRequest(endpoint: string): void {
    const key = `${endpoint}:${Date.now() / PERFORMANCE.RATE_LIMIT_WINDOW}`;
    this.requestMetrics.set(key, (this.requestMetrics.get(key) ?? 0) + 1);
  }

  isRateLimited(endpoint: string): boolean {
    const key = `${endpoint}:${Date.now() / PERFORMANCE.RATE_LIMIT_WINDOW}`;
    const count = this.requestMetrics.get(key) ?? 0;
    return count > PERFORMANCE.RATE_LIMIT_MAX_REQUESTS;
  }
}

const state = new StateManager();

// ============================================================
// TELEGRAM CLIENT
// ============================================================

class TelegramManager {
  private client: TelegramClient;
  private bot: Bot;
  private connected = false;

  constructor(token: string, apiId: number, apiHash: string) {
    const session = new sessions.StringSession("");

    this.client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      requestRetries: 3,
      autoReconnect: true,
    });

    this.bot = new Bot(token);
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
      await this.client.start({
        botAuthToken: config.token,
      });

      this.connected = true;
      logger.info("✅ Telegram MTProto connected");
    } catch (error) {
      logger.error({ error }, "❌ Telegram connection failed");
      throw error;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getClient(): TelegramClient {
    return this.client;
  }

  getBot(): Bot {
    return this.bot;
  }

  async getMessage(chatId: string, messageId: number) {
    try {
      const messages = await this.client.getMessages(chatId, {
        ids: [messageId],
      });

      const message = messages[0];
      if (!message) throw new Error("Message not found");
      if (!message.media) throw new Error("Media not found in message");

      return message;
    } catch (error) {
      logger.error({ error, chatId, messageId }, "Failed to get message");
      throw error;
    }
  }

  async downloadChunk(
    message: any,
    fileSize: number,
    start: number,
    end: number,
  ): Promise<Buffer> {
    try {
      const length = end - start + 1;
      const chunks: Buffer[] = [];
      let downloaded = 0;

      const mediaFile = message.media;
      if (!mediaFile) throw new Error("Media not found");

      const iterator = this.client.iterDownload({
        file: mediaFile,
        offset: bigInt(start),
        limit: length,
        fileSize: bigInt(fileSize),
        requestSize: PERFORMANCE.TELEGRAM_REQUEST_SIZE,
      });

      for await (const chunk of iterator) {
        const buffer = Buffer.from(chunk);
        const remaining = length - downloaded;

        if (remaining <= 0) break;

        const data =
          buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;

        chunks.push(data);
        downloaded += data.length;

        if (downloaded >= length) break;
      }

      return Buffer.concat(chunks);
    } catch (error) {
      logger.error({ error, start, end }, "Download chunk failed");
      throw error;
    }
  }
}

// ============================================================
// CACHE MANAGER
// ============================================================

class CacheManager {
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  start(): void {
    // Background cleanup har 5 minutda
    this.cleanupInterval = setInterval(
      () => {
        const beforeSize = state.getCacheSizeMB();
        // Cleanup done in setCache
        const afterSize = state.getCacheSizeMB();

        if (beforeSize !== afterSize) {
          logger.debug(
            { before: beforeSize, after: afterSize },
            "Cache cleaned up",
          );
        }
      },
      5 * 60 * 1000,
    );
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// ============================================================
// UTILS
// ============================================================

function createMediaId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function createChunkKey(mediaId: string, start: number): string {
  return `${mediaId}:${start}`;
}

function logMedia(media: MediaRecord): void {
  logger.info(
    {
      id: media.id,
      type: media.type,
      fileId: media.fileId,
      chatId: media.chatId,
      messageId: media.messageId,
      fileSize: media.fileSize,
      mimeType: media.mimeType,
      fileName: media.fileName,
      url: `${config.publicUrl}/api/${media.type}/${media.id}`,
    },
    `📦 ${media.type === "video" ? "🎬 VIDEO" : "🖼 PHOTO"} saved`,
  );
}

// ============================================================
// EXPRESS APP
// ============================================================

const app = express();

// Middleware
app.use(compression());
app.disable("x-powered-by"); // Remove header for speed
app.use(
  cors({
    origin: "*",
    methods: ["GET", "HEAD", "OPTIONS"],
    credentials: false,
  }),
);
app.use(express.json({ limit: "10kb" }));

// Skip compression for media streams
app.use("/api/video", (req: Request, res: Response, next: any) => {
  res.setHeader("Content-Encoding", "identity");
  next();
});
app.use("/api/image", (req: Request, res: Response, next: any) => {
  res.setHeader("Content-Encoding", "identity");
  next();
});

// Keep-alive
app.use((req: Request, res: Response, next: any) => {
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Keep-Alive", "timeout=65, max=100");
  next();
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: any) => {
  logger.error({ error: err, path: req.path }, "Unhandled error");

  if (!res.headersSent) {
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

// ============================================================
// ROUTES - INFO
// ============================================================

app.get("/", (req: Request, res: Response) => {
  const stats = state.getStats();

  res.json({
    success: true,
    message: "🚀 Telegram Media Streaming API",
    status: "running",
    telegram: telegramManager.isConnected(),
    stats,
    performance: PERFORMANCE,
    config: {
      publicUrl: config.publicUrl,
      port: config.port,
    },
  });
});

app.get("/health", (req: Request, res: Response) => {
  const stats = state.getStats();

  res.json({
    success: true,
    status: "healthy",
    uptime: process.uptime(),
    telegram: telegramManager.isConnected(),
    stats,
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// ROUTES - MEDIA LIST
// ============================================================

app.get("/api/media", (req: Request, res: Response) => {
  const media = state.getAllMedia();

  res.json({
    success: true,
    count: media.length,
    media: media.map((m) => ({
      id: m.id,
      type: m.type,
      fileId: m.fileId,
      chatId: m.chatId,
      messageId: m.messageId,
      fileSize: m.fileSize,
      mimeType: m.mimeType,
      fileName: m.fileName,
      accessCount: m.accessCount,
      createdAt: m.createdAt,
    })),
  });
});

app.get("/api/media/:id", (req: Request, res: Response) => {
  const media = state.getMedia(req.params.id as string);

  if (!media) {
    return res.status(404).json({
      success: false,
      message: "Media not found",
    });
  }

  res.json({
    success: true,
    media,
    url: `${config.publicUrl}/api/${media.type}/${media.id}`,
  });
});

// ============================================================
// ROUTES - VIDEO STREAMING
// ============================================================

app.get("/api/video/:id", async (req: Request, res: Response) => {
  try {
    // Rate limit check
    if (state.isRateLimited(`/api/video/${req.params.id}`)) {
      return res.status(429).json({
        success: false,
        message: "Too many requests",
      });
    }

    state.recordRequest(`/api/video/${req.params.id}`);

    const media = state.getMedia(req.params.id as string);

    if (!media) {
      return res.status(404).send("Video not found");
    }

    if (media.type !== "video") {
      return res.status(400).send("This is not a video");
    }

    const totalSize = Number(media.fileSize);

    if (!Number.isFinite(totalSize) || totalSize <= 0) {
      return res.status(500).send("Invalid video size");
    }

    if (totalSize > PERFORMANCE.MAX_VIDEO_SIZE) {
      return res.status(400).send("Video too large");
    }

    // Parse range header
    let start = 0;
    let end = Math.min(PERFORMANCE.CHUNK_SIZE - 1, totalSize - 1);

    const range = req.headers.range;

    if (range) {
      const match = range.match(/^bytes=(\d+)-(\d*)$/);

      if (!match) {
        res.setHeader("Content-Range", `bytes */${totalSize}`);
        return res.status(416).end();
      }

      start = Number(match[1]);

      if (match[2]) {
        end = Number(match[2]);
      } else {
        end = Math.min(start + PERFORMANCE.CHUNK_SIZE - 1, totalSize - 1);
      }

      if (start < 0 || start >= totalSize || start > end) {
        res.setHeader("Content-Range", `bytes */${totalSize}`);
        return res.status(416).end();
      }

      end = Math.min(end, totalSize - 1);
    }

    // Limit range size
    if (end - start + 1 > PERFORMANCE.CHUNK_SIZE) {
      end = start + PERFORMANCE.CHUNK_SIZE - 1;
      end = Math.min(end, totalSize - 1);
    }

    // Chunk alignment
    const chunkStart =
      Math.floor(start / PERFORMANCE.CHUNK_SIZE) * PERFORMANCE.CHUNK_SIZE;
    const chunkEnd = Math.min(
      chunkStart + PERFORMANCE.CHUNK_SIZE - 1,
      totalSize - 1,
    );

    logger.debug(
      {
        mediaId: media.id,
        requested: `${start}-${end}`,
        chunk: `${chunkStart}-${chunkEnd}`,
        range: range || "none",
      },
      "🎥 Video request",
    );

    // Download chunk
    const chunk = await downloadVideoChunk(media, chunkStart, chunkEnd);

    if (!chunk || chunk.length === 0) {
      return res.status(500).send("Empty chunk");
    }

    // Slice request data
    const relativeStart = start - chunkStart;
    const relativeEnd = Math.min(end - chunkStart, chunk.length - 1);

    if (relativeStart < 0 || relativeStart >= chunk.length) {
      return res.status(500).send("Chunk range error");
    }

    const data = chunk.subarray(relativeStart, relativeEnd + 1);

    // Set response headers
    res.status(range ? 206 : 200);
    res.setHeader("Content-Type", media.mimeType || "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(data.length));
    res.setHeader(
      "Content-Range",
      `bytes ${start}-${start + data.length - 1}/${totalSize}`,
    );

    // Handle download parameter
    const isDownload =
      req.query.download === "1" || req.query.download === "true";
    const fileName = media.fileName || `media_${media.id}.mp4`;
    res.setHeader(
      "Content-Disposition",
      isDownload ? `attachment; filename="${fileName}"` : "inline",
    );
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("ETag", `"${media.id}-${chunkStart}"`);
    res.setHeader("X-Cache-Size-MB", state.getCacheSizeMB().toFixed(2));
    res.setHeader("X-Chunk-Size", `${data.length}`);
    res.setHeader("X-Speed-Optimized", "true");

    // Send data with highWaterMark for faster streaming
    res.end(data);

    // Prefetch next chunks aggressively
    prefetchNextChunks(media, chunkStart);

    logger.debug(
      { size: data.length, duration: Date.now() },
      `⚡ Sent ${data.length} bytes`,
    );
  } catch (error) {
    logger.error({ error, id: req.params.id }, "❌ Video streaming error");

    if (!res.headersSent) {
      res.status(500).send("Video streaming error");
    }

    if (!res.destroyed) {
      res.destroy();
    }
  }
});

// ============================================================
// ROUTES - IMAGE
// ============================================================

app.get("/api/image/:id", async (req: Request, res: Response) => {
  try {
    state.recordRequest("/api/image");

    const media = state.getMedia(req.params.id as string);

    if (!media) {
      return res.status(404).send("Image not found");
    }

    if (media.type !== "photo") {
      return res.status(400).send("This is not a photo");
    }

    const message = await telegramManager.getMessage(
      media.chatId,
      media.messageId,
    );

    const buffer = await telegramManager.downloadChunk(
      message,
      media.fileSize,
      0,
      media.fileSize - 1,
    );

    res.setHeader("Content-Type", media.mimeType || "image/jpeg");
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("ETag", `"${media.id}"`);

    // Handle download parameter
    const isDownload =
      req.query.download === "1" || req.query.download === "true";
    const fileName = media.fileName || `image_${media.id}.jpg`;
    res.setHeader(
      "Content-Disposition",
      isDownload ? `attachment; filename="${fileName}"` : "inline",
    );

    return res.end(buffer);
  } catch (error) {
    logger.error({ error, id: req.params.id }, "❌ Image download error");

    if (!res.headersSent) {
      return res.status(500).send("Image download error");
    }

    res.destroy();
  }
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

async function downloadVideoChunk(
  media: MediaRecord,
  start: number,
  end: number,
): Promise<Buffer> {
  const key = createChunkKey(media.id, start);

  // Check cache
  const cached = state.getCache(key);
  if (cached) {
    logger.debug({ start, end }, "⚡ Cache hit");
    return cached;
  }

  // Check active download
  const existing = state.getActiveDownload(key);
  if (existing) {
    logger.debug({ start, end }, "⏳ Waiting for existing download");
    return existing;
  }

  // Create download promise
  const promise = (async () => {
    try {
      state.incrementActiveTelegramDownloads();

      logger.debug({ start, end }, "⬇️ Downloading chunk from Telegram");

      const message = await telegramManager.getMessage(
        media.chatId,
        media.messageId,
      );

      const buffer = await telegramManager.downloadChunk(
        message,
        media.fileSize,
        start,
        end,
      );

      // Cache it
      state.setCache(key, buffer);

      logger.debug({ size: buffer.length }, `✅ Chunk downloaded and cached`);

      return buffer;
    } finally {
      state.decrementActiveTelegramDownloads();
      state.deleteActiveDownload(key);
    }
  })();

  state.setActiveDownload(key, promise);

  return promise;
}

function prefetchNextChunks(media: MediaRecord, currentStart: number): void {
  for (let i = 1; i <= PERFORMANCE.PREFETCH_CHUNKS; i++) {
    const prefetchStart = currentStart + PERFORMANCE.CHUNK_SIZE * i;

    if (prefetchStart >= media.fileSize) break;

    const prefetchEnd = Math.min(
      prefetchStart + PERFORMANCE.CHUNK_SIZE - 1,
      media.fileSize - 1,
    );

    const key = createChunkKey(media.id, prefetchStart);

    if (state.getCache(key) || state.hasActiveDownload(key)) continue;

    // Background prefetch
    downloadVideoChunk(media, prefetchStart, prefetchEnd).catch((error) => {
      logger.warn({ error }, "⚠️ Prefetch error");
    });
  }
}

// ============================================================
// TELEGRAM BOT HANDLERS
// ============================================================

function setupBotHandlers(telegramManager: TelegramManager): void {
  const bot = telegramManager.getBot();

  bot.on("message", async (ctx: any) => {
    try {
      const message = ctx.message;

      if (!isAdminChat(ctx.chat.id)) {
        await ctx.reply("❌ Faqat admin video va rasm yuborishi mumkin.");
        return;
      }

      logger.info(
        { chatId: ctx.chat.id, messageId: message.message_id },
        "📩 Telegram message received",
      );

      // Handle video
      if ("video" in message) {
        const video = message.video;
        const sizeMB = (
          video.file_size ? video.file_size / 1024 / 1024 : 0
        ).toFixed(2);
        const durationMin = video.duration
          ? Math.floor(video.duration / 60)
          : 0;
        const durationSec = video.duration ? video.duration % 60 : 0;

        const media: MediaRecord = {
          id: createMediaId(),
          fileId: video.file_id,
          chatId: String(ctx.chat.id),
          messageId: message.message_id,
          type: "video",
          fileSize: video.file_size ?? 0,
          mimeType: video.mime_type || "video/mp4",
          fileName: video.file_name ?? "video.mp4",
          width: video.width,
          height: video.height,
          duration: video.duration,
          createdAt: Date.now(),
          accessCount: 0,
        };

        state.addMedia(media);
        logMedia(media);

        const videoUrl = `${config.publicUrl}/api/video/${media.id}`;
        const replyText =
          `✅ Saqlandi\n\n` +
          `🆔 ID: ${media.id}\n` +
          `📦 Hajm: ${sizeMB} MB\n` +
          `⏱ ${durationMin}:${String(durationSec).padStart(2, "0")} min\n` +
          `📐 ${video.width || "?"}x${video.height || "?"}`;

        await ctx.reply(replyText, {
          reply_markup: createMediaButtons(videoUrl),
        });
        return;
      }

      // Handle document video
      if ("document" in message) {
        const document = message.document;

        const mime = document.mime_type || "";
        const fileName = document.file_name || "file";
        const isVideo =
          mime.startsWith("video/") ||
          /\.(mp4|mkv|webm|mov|avi)$/i.test(fileName);

        if (!isVideo) {
          await ctx.reply("❌ Faqat video fayllar qabul qilinadi.");
          return;
        }

        const sizeMB = (
          document.file_size ? document.file_size / 1024 / 1024 : 0
        ).toFixed(2);

        const media: MediaRecord = {
          id: createMediaId(),
          fileId: document.file_id,
          chatId: String(ctx.chat.id),
          messageId: message.message_id,
          type: "video",
          fileSize: document.file_size ?? 0,
          mimeType: mime || "video/mp4",
          fileName,
          createdAt: Date.now(),
          accessCount: 0,
        };

        state.addMedia(media);
        logMedia(media);

        const videoUrl = `${config.publicUrl}/api/video/${media.id}`;
        const replyText =
          `✅ Saqlandi\n\n` +
          `🆔 ID: ${media.id}\n` +
          `📦 Hajm: ${sizeMB} MB\n` +
          `📁 ${fileName}`;

        await ctx.reply(replyText, {
          reply_markup: createMediaButtons(videoUrl),
        });
        return;
      }

      // Handle photo
      if ("photo" in message) {
        const photos = message.photo;

        if (!photos || photos.length === 0) {
          throw new Error("Photo not found");
        }

        const photo = photos[photos.length - 1];

        if (!photo) {
          throw new Error("Photo not found");
        }

        const sizeMB = (
          photo.file_size ? photo.file_size / 1024 / 1024 : 0
        ).toFixed(2);

        const media: MediaRecord = {
          id: createMediaId(),
          fileId: photo.file_id,
          chatId: String(ctx.chat.id),
          messageId: message.message_id,
          type: "photo",
          fileSize: photo.file_size ?? 0,
          width: photo.width,
          height: photo.height,
          createdAt: Date.now(),
          accessCount: 0,
        };

        state.addMedia(media);
        logMedia(media);

        const imageUrl = `${config.publicUrl}/api/image/${media.id}`;
        const replyText =
          `✅ Saqlandi\n\n` +
          `🆔 ID: ${media.id}\n` +
          `📦 Hajm: ${sizeMB} MB\n` +
          `📐 ${photo.width || "?"}x${photo.height || "?"}`;

        await ctx.reply(replyText, {
          reply_markup: createMediaButtons(imageUrl),
        });
        return;
      }
    } catch (error) {
      logger.error(
        {
          error,
          errorMessage: (error as Error).message,
          stack: (error as Error).stack,
        },
        "❌ Message handler error",
      );

      try {
        await ctx.reply(
          "❌ Xatolik yuz berdi: " +
            ((error as Error).message || "Unknown error"),
        );
      } catch (replyError) {
        logger.error({ replyError }, "Failed to send error reply");
      }
    }
  });

  bot.catch((error: any) => {
    logger.error({ error }, "❌ Bot error");
  });
}

// ============================================================
// INITIALIZATION
// ============================================================

let telegramManager: TelegramManager;
const cacheManager = new CacheManager();

async function start(): Promise<void> {
  try {
    logger.info("🚀 Starting Telegram Media Streaming API");

    // Initialize Telegram
    telegramManager = new TelegramManager(
      config.token,
      config.apiId,
      config.apiHash,
    );
    await telegramManager.connect();

    // Setup bot handlers
    setupBotHandlers(telegramManager);

    // Start cache manager
    cacheManager.start();

    // Start Express server
    const server = app.listen(config.port, "0.0.0.0", () => {
      logger.info(
        {
          port: config.port,
          publicUrl: config.publicUrl,
          chunkSizeMB: PERFORMANCE.CHUNK_SIZE / 1024 / 1024,
          cacheSizeMB: PERFORMANCE.MAX_CACHE_BYTES / 1024 / 1024,
          parallelDownloads: PERFORMANCE.MAX_TELEGRAM_DOWNLOADS,
        },
        "🚀 API Server started",
      );
    });

    // Graceful shutdown
    process.on("SIGINT", async () => {
      logger.info("Shutting down...");

      server.close(async () => {
        cacheManager.stop();
        logger.info("Server closed");
        process.exit(0);
      });
    });

    // Start bot
    telegramManager.getBot().start();
    logger.info("🤖 Telegram bot started");
  } catch (error) {
    logger.error({ error }, "❌ Startup failed");
    process.exit(1);
  }
}

// ============================================================
// RUN
// ============================================================

start();
