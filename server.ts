import "dotenv/config";

import bigInt from "big-integer";
import compression from "compression";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { Bot } from "grammy";
import pino from "pino";
import { sessions, TelegramClient } from "telegram";

// ============================================================
// LOGGER
// ============================================================

const logger = pino.default({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
    options: { colorize: true, translateTime: "SYS:standard" },
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
  const apiHash = process.env.API_HASH ?? "";
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
        { text: "👁 Tomosha qilish", url: mediaUrl },
        {
          text: "📋 Linkni nusxalash",
          url: `https://t.me/share/url?url=${encodeURIComponent(mediaUrl)}`,
        },
      ],
    ],
  };
}

// ============================================================
// PERFORMANCE (documented)
// - FIRST_CHUNK_SIZE: initial bytes to prefetch & pin (first-byte acceleration)
// - START_CHUNK_SIZE: alignment for very small start offsets
// - CHUNK_SIZE: normal chunk size after initial
// - PREFETCH_* flags control prefetching
// ============================================================

const PERFORMANCE = {
  // first chunk prefetch size to accelerate first-byte (8 MB)
  FIRST_CHUNK_SIZE: 8 * 1024 * 1024,

  // alignment chunk for small seeks (4 MB)
  START_CHUNK_SIZE: 4 * 1024 * 1024,

  // standard chunk size for regular streaming (32 MB)
  CHUNK_SIZE: 32 * 1024 * 1024,

  // Cache size: 1.5 GB (within 1.5-2 GB requirement)
  MAX_CACHE_BYTES: Math.floor(1.5 * 1024 * 1024 * 1024),

  // Keep first chunks pinned (never evicted)
  PREFETCH_ON_SAVE: true,
  PREFETCH_FIRST_CHUNKS: 3, // number of FIRST_CHUNK_SIZE blocks to prefetch on save

  // Telegram parallelism and request sizes
  MAX_TELEGRAM_DOWNLOADS: 24,
  TELEGRAM_REQUEST_SIZE: 16 * 1024 * 1024,

  // Cache TTL and housekeeping
  CACHE_TTL: 60 * 60 * 1000, // 60 minutes

  // Rate limiting window (ms)
  RATE_LIMIT_WINDOW: 60 * 1000,
  RATE_LIMIT_MAX_REQUESTS: 5000,
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
  ttl?: number;
  pinned?: boolean;
}

interface MessageCacheEntry {
  key: string;
  value: any;
  createdAt: number;
  ttl: number;
}

// ============================================================
// STATE / CACHE MANAGER
// - LRU behavior via Map insertion order
// - Pinned keys are never evicted
// - TTL + size enforcement
// ============================================================

class StateManager {
  private mediaDB = new Map<string, MediaRecord>();
  private cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  private activeDownloads = new Map<string, Promise<Buffer>>();
  private activeTelegramDownloads = 0;
  private requestMetrics = new Map<string, number>();
  private pinnedKeys = new Set<string>();
  private messageCache = new Map<string, MessageCacheEntry>();

  // Getters
  getMedia(id: string): MediaRecord | undefined {
    const media = this.mediaDB.get(id);
    if (media) media.accessCount++;
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
      activeChunkDownloads: this.activeDownloads.size,
      pinnedEntries: this.pinnedKeys.size,
    };
  }

  addMedia(media: MediaRecord): void {
    this.mediaDB.set(media.id, media);
  }

  // Cache: LRU + TTL + pinned
  getCache(key: string): Buffer | null {
    this.cleanExpiredCache();
    const entry = this.cache.get(key);
    if (!entry) return null;
    entry.lastAccess = Date.now();
    // Move to end to mark as recently used
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.buffer;
  }

  setCache(
    key: string,
    buffer: Buffer,
    opts?: { ttl?: number; pinned?: boolean },
  ): void {
    this.cleanExpiredCache();

    if (buffer.length > PERFORMANCE.MAX_CACHE_BYTES) {
      logger.warn({ key, size: buffer.length }, "Buffer too large to cache");
      return;
    }

    // If already cached, remove first
    this.removeCache(key, { force: true });

    const entry: CacheEntry = {
      key,
      buffer,
      createdAt: Date.now(),
      lastAccess: Date.now(),
      size: buffer.length,
      ttl: opts?.ttl,
      pinned: !!opts?.pinned,
    };

    if (entry.pinned) this.pinnedKeys.add(key);

    this.cache.set(key, entry);
    this.cacheBytes += buffer.length;

    // Evict least-recently-used non-pinned entries until under limit
    if (this.cacheBytes > PERFORMANCE.MAX_CACHE_BYTES) {
      for (const [k, e] of this.cache) {
        if (this.cacheBytes <= PERFORMANCE.MAX_CACHE_BYTES) break;
        if (e.pinned) continue; // never evict pinned
        this.removeCache(k);
      }
    }
  }

  removeCache(key: string, opts?: { force?: boolean }): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    if (entry.pinned && !opts?.force) return;
    this.cacheBytes -= entry.size;
    this.cache.delete(key);
    this.pinnedKeys.delete(key);
  }

  cleanExpiredCache(): void {
    const now = Date.now();
    const toDelete: string[] = [];
    for (const [k, e] of this.cache) {
      if (e.ttl && now - e.createdAt > e.ttl) {
        if (!e.pinned) toDelete.push(k);
      } else if (!e.ttl && now - e.createdAt > PERFORMANCE.CACHE_TTL) {
        if (!e.pinned) toDelete.push(k);
      }
    }
    toDelete.forEach((k) => this.removeCache(k));
  }

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

  incrementActiveTelegramDownloads(): void {
    this.activeTelegramDownloads++;
  }
  decrementActiveTelegramDownloads(): void {
    this.activeTelegramDownloads = Math.max(
      0,
      this.activeTelegramDownloads - 1,
    );
  }

  // Rate limiting using integer window key
  recordRequest(endpoint: string): void {
    const key = `${endpoint}:${Math.floor(Date.now() / PERFORMANCE.RATE_LIMIT_WINDOW)}`;
    this.requestMetrics.set(key, (this.requestMetrics.get(key) ?? 0) + 1);
  }

  isRateLimited(endpoint: string): boolean {
    const key = `${endpoint}:${Math.floor(Date.now() / PERFORMANCE.RATE_LIMIT_WINDOW)}`;
    const count = this.requestMetrics.get(key) ?? 0;
    return count > PERFORMANCE.RATE_LIMIT_MAX_REQUESTS;
  }

  // Message cache (getMessage results): short TTL
  getMessageCache(key: string): any | null {
    const entry = this.messageCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > entry.ttl) {
      this.messageCache.delete(key);
      return null;
    }
    return entry.value;
  }

  setMessageCache(key: string, value: any, ttl = 5 * 60 * 1000): void {
    this.messageCache.set(key, { key, value, createdAt: Date.now(), ttl });
  }
}

const state = new StateManager();

// ============================================================
// TELEGRAM MANAGER
// - caches getMessage results
// - uses TELEGRAM_REQUEST_SIZE
// - ensures activeDownloads concurrency is respected
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
      await this.client.start({ botAuthToken: config.token });
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

  // getMessage with caching to avoid repeated RPCs
  async getMessage(chatId: string, messageId: number) {
    const key = `${chatId}:${messageId}`;
    const cached = state.getMessageCache(key);
    if (cached) {
      logger.debug({ chatId, messageId }, "⚡ getMessage cache hit");
      return cached;
    }

    try {
      const messages = await this.client.getMessages(chatId, {
        ids: [messageId],
      });
      const message = messages[0];
      if (!message) throw new Error("Message not found");
      if (!message.media) throw new Error("Media not found in message");
      state.setMessageCache(key, message, 5 * 60 * 1000); // 5 min cache
      return message;
    } catch (error) {
      logger.error({ error, chatId, messageId }, "Failed to get message");
      throw error;
    }
  }

  // Download chunk uses client's iterDownload and respects requestSize
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

let telegramManager: TelegramManager;

// ============================================================
// HELPERS
// ============================================================

function createMediaId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function createChunkKey(mediaId: string, start: number, size?: number) {
  return `${mediaId}:${start}:${size ?? PERFORMANCE.CHUNK_SIZE}`;
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

// Prefetch initial chunks and pin them
async function prefetchInitialChunks(media: MediaRecord): Promise<void> {
  if (!PERFORMANCE.PREFETCH_ON_SAVE) return;

  const firstChunkSize = PERFORMANCE.FIRST_CHUNK_SIZE;
  const blocks = Math.max(1, PERFORMANCE.PREFETCH_FIRST_CHUNKS);

  logger.info(
    { mediaId: media.id, blocks, firstChunkSize },
    "🚀 Prefetch initial chunks started",
  );

  try {
    const message = await telegramManager.getMessage(
      media.chatId,
      media.messageId,
    );

    for (let i = 0; i < blocks; i++) {
      const start = i * firstChunkSize;
      if (start >= media.fileSize) break;
      const end = Math.min(start + firstChunkSize - 1, media.fileSize - 1);
      const key = createChunkKey(media.id, start, firstChunkSize);
      if (state.getCache(key) || state.hasActiveDownload(key)) continue;

      // Download in background and pin
      const p = (async () => {
        try {
          state.incrementActiveTelegramDownloads();
          const buffer = await telegramManager.downloadChunk(
            message,
            media.fileSize,
            start,
            end,
          );
          state.setCache(key, buffer, {
            pinned: true,
            ttl: PERFORMANCE.CACHE_TTL,
          });
          logger.info(
            { mediaId: media.id, start, size: buffer.length },
            "✅ Prefetched and pinned chunk",
          );
        } catch (err) {
          logger.warn(
            { err, mediaId: media.id, start },
            "⚠️ Prefetch chunk failed",
          );
        } finally {
          state.decrementActiveTelegramDownloads();
        }
      })();

      // don't await here; let it run in background
    }
  } catch (err) {
    logger.warn(
      { err, mediaId: media.id },
      "⚠️ Prefetch initial chunks failed to start",
    );
  }
}

// Prefetch next normal chunks (not pinned) after serving a chunk
function prefetchNextChunks(media: MediaRecord, currentStart: number): void {
  for (let i = 1; i <= 2; i++) {
    const prefetchStart = currentStart + PERFORMANCE.CHUNK_SIZE * i;
    if (prefetchStart >= media.fileSize) break;
    const prefetchEnd = Math.min(
      prefetchStart + PERFORMANCE.CHUNK_SIZE - 1,
      media.fileSize - 1,
    );
    const key = createChunkKey(media.id, prefetchStart);
    if (state.getCache(key) || state.hasActiveDownload(key)) continue;
    downloadVideoChunk(media, prefetchStart, prefetchEnd).catch((error) =>
      logger.warn(
        { error, mediaId: media.id, start: prefetchStart },
        "⚠️ Prefetch next chunk failed",
      ),
    );
  }
}

// Ensures concurrency limit for telegram downloads by awaiting if too many active
async function throttleTelegramDownload(): Promise<void> {
  const max = PERFORMANCE.MAX_TELEGRAM_DOWNLOADS;
  while (state.getStats().activeTelegramDownloads >= max) {
    // simple wait: back off 50ms
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Download video chunk with adaptive sizing and caching
async function downloadVideoChunk(
  media: MediaRecord,
  start: number,
  end: number,
): Promise<Buffer> {
  // handle invalid sizes
  const totalSize = Number(media.fileSize);
  if (!Number.isFinite(totalSize) || totalSize <= 0)
    throw new Error("Invalid media size");

  // Determine adaptive chunk boundaries
  const isFirstRequest = start === 0;
  let chunkSize = PERFORMANCE.CHUNK_SIZE;
  if (isFirstRequest)
    chunkSize = Math.max(PERFORMANCE.FIRST_CHUNK_SIZE, PERFORMANCE.CHUNK_SIZE);
  if (start < PERFORMANCE.FIRST_CHUNK_SIZE && start !== 0)
    chunkSize = PERFORMANCE.START_CHUNK_SIZE;

  const chunkStart = Math.floor(start / chunkSize) * chunkSize;
  const chunkEnd = Math.min(chunkStart + chunkSize - 1, totalSize - 1);

  const key = createChunkKey(media.id, chunkStart, chunkSize);

  // Cache check
  const cached = state.getCache(key);
  if (cached) {
    logger.debug({ mediaId: media.id, start, chunkStart }, "⚡ Cache hit");
    return cached;
  }

  // Active download dedupe
  const existing = state.getActiveDownload(key);
  if (existing) {
    logger.debug(
      { mediaId: media.id, chunkStart },
      "⏳ Waiting existing download",
    );
    return existing;
  }

  // throttle to keep parallel downloads under limit
  await throttleTelegramDownload();

  const promise = (async () => {
    try {
      state.incrementActiveTelegramDownloads();
      logger.debug(
        { mediaId: media.id, chunkStart, chunkEnd },
        "⬇️ Downloading chunk from Telegram",
      );
      const message = await telegramManager.getMessage(
        media.chatId,
        media.messageId,
      );
      const buffer = await telegramManager.downloadChunk(
        message,
        media.fileSize,
        chunkStart,
        chunkEnd,
      );

      // Pin first chunk (0) and first blocks
      const pinned =
        chunkStart === 0 && chunkSize >= PERFORMANCE.FIRST_CHUNK_SIZE;
      state.setCache(key, buffer, { ttl: PERFORMANCE.CACHE_TTL, pinned });

      logger.debug(
        { mediaId: media.id, size: buffer.length, pinned },
        "✅ Chunk downloaded and cached",
      );
      return buffer;
    } catch (err) {
      logger.error(
        { err, mediaId: media.id, chunkStart },
        "❌ Chunk download failed",
      );
      throw err;
    } finally {
      state.decrementActiveTelegramDownloads();
      state.deleteActiveDownload(key);
    }
  })();

  state.setActiveDownload(key, promise);
  return promise;
}

// ============================================================
// EXPRESS APP
// ============================================================

const app = express();
app.use(compression());
app.disable("x-powered-by");
app.use(
  cors({
    origin: "*",
    methods: ["GET", "HEAD", "OPTIONS"],
    credentials: false,
  }),
);
app.use(express.json({ limit: "10kb" }));

// Keep-alive headers applied globally
app.use((req: Request, res: Response, next) => {
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Keep-Alive", "timeout=120, max=1000");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length,Content-Range,ETag,Cache-Control,X-Chunk-Size,X-Cache-Size-MB",
  );
  next();
});

// Special: disable compression for media endpoints
app.use((req, res, next) => {
  if (req.path.startsWith("/api/video") || req.path.startsWith("/api/image")) {
    res.setHeader("Content-Encoding", "identity");
  }
  next();
});

// Error middleware will be attached at the end

// ============================================================
// ROUTES
// ============================================================

app.get("/", (req: Request, res: Response) => {
  res.json({
    success: true,
    message: "🚀 Telegram Media Streaming API",
    status: "running",
    telegram: telegramManager?.isConnected() ?? false,
    stats: state.getStats(),
    performance: PERFORMANCE,
    config: { publicUrl: config.publicUrl, port: config.port },
  });
});

app.get("/health", (req: Request, res: Response) => {
  res.json({
    success: true,
    status: "healthy",
    uptime: process.uptime(),
    telegram: telegramManager?.isConnected() ?? false,
    stats: state.getStats(),
    timestamp: new Date().toISOString(),
  });
});

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
  if (!media)
    return res.status(404).json({ success: false, message: "Media not found" });
  res.json({
    success: true,
    media,
    url: `${config.publicUrl}/api/${media.type}/${media.id}`,
  });
});

// Video streaming with adaptive chunking and headers
app.get("/api/video/:id", async (req: Request, res: Response) => {
  try {
    const endpoint = `/api/video/${req.params.id}`;
    if (state.isRateLimited(endpoint))
      return res
        .status(429)
        .json({ success: false, message: "Too many requests" });
    state.recordRequest(endpoint);

    const media = state.getMedia(req.params.id as string);
    if (!media) return res.status(404).send("Video not found");
    if (media.type !== "video")
      return res.status(400).send("This is not a video");

    const totalSize = Number(media.fileSize);
    if (!Number.isFinite(totalSize) || totalSize <= 0)
      return res.status(500).send("Invalid video size");

    // Parse range header and compute requested window
    const rangeHeader = req.headers.range as string | undefined;
    let reqStart = 0;
    let reqEnd = Math.min(PERFORMANCE.CHUNK_SIZE - 1, totalSize - 1);
    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
      if (!match) {
        res.setHeader("Content-Range", `bytes */${totalSize}`);
        return res.status(416).end();
      }
      reqStart = Number(match[1]);
      reqEnd = match[2]
        ? Number(match[2])
        : Math.min(reqStart + PERFORMANCE.CHUNK_SIZE - 1, totalSize - 1);
      if (reqStart < 0 || reqStart >= totalSize || reqStart > reqEnd) {
        res.setHeader("Content-Range", `bytes */${totalSize}`);
        return res.status(416).end();
      }
    }

    // Limit maximum requested segment to reasonable chunk size
    if (reqEnd - reqStart + 1 > PERFORMANCE.CHUNK_SIZE)
      reqEnd = reqStart + PERFORMANCE.CHUNK_SIZE - 1;

    // Compute adaptive chunk to download (may be larger than requested slice)
    const isFirstByte = reqStart === 0;
    let chunkSize = isFirstByte
      ? PERFORMANCE.FIRST_CHUNK_SIZE
      : PERFORMANCE.CHUNK_SIZE;
    if (reqStart < PERFORMANCE.START_CHUNK_SIZE && !isFirstByte)
      chunkSize = PERFORMANCE.START_CHUNK_SIZE;

    const chunkStart = Math.floor(reqStart / chunkSize) * chunkSize;
    const chunkEnd = Math.min(chunkStart + chunkSize - 1, totalSize - 1);

    logger.debug(
      {
        mediaId: media.id,
        requested: `${reqStart}-${reqEnd}`,
        chunk: `${chunkStart}-${chunkEnd}`,
        range: rangeHeader || "none",
      },
      "🎥 Video request",
    );

    const chunk = await downloadVideoChunk(media, chunkStart, chunkEnd);
    if (!chunk || chunk.length === 0)
      return res.status(500).send("Empty chunk");

    const relativeStart = reqStart - chunkStart;
    const relativeEnd = Math.min(reqEnd - chunkStart, chunk.length - 1);
    if (relativeStart < 0 || relativeStart > relativeEnd)
      return res.status(500).send("Chunk range error");

    const data = chunk.subarray(relativeStart, relativeEnd + 1);

    // Response headers required (per specification)
    res.status(rangeHeader ? 206 : 200);
    res.setHeader("Content-Type", media.mimeType || "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Keep-Alive", "timeout=120, max=1000");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Length,Content-Range,ETag,Cache-Control,X-Chunk-Size,X-Cache-Size-MB",
    );
    res.setHeader("Content-Length", String(data.length));
    res.setHeader(
      "Content-Range",
      `bytes ${reqStart}-${reqStart + data.length - 1}/${totalSize}`,
    );
    res.setHeader("ETag", `"${media.id}-${chunkStart}"`);
    res.setHeader("X-Chunk-Size", `${chunk.length}`);
    res.setHeader("X-Cache-Size-MB", state.getCacheSizeMB().toFixed(2));

    const isDownload =
      req.query.download === "1" || req.query.download === "true";
    const fileName = media.fileName || `media_${media.id}.mp4`;
    res.setHeader(
      "Content-Disposition",
      isDownload ? `attachment; filename="${fileName}"` : "inline",
    );

    // Send the requested slice
    res.end(data);

    // Background: prefetch next normal chunks
    prefetchNextChunks(media, chunkStart);
    logger.debug({ size: data.length }, `⚡ Sent ${data.length} bytes`);
  } catch (error) {
    logger.error({ error, id: req.params.id }, "❌ Video streaming error");
    if (!res.headersSent) res.status(500).send("Video streaming error");
    if (!res.destroyed) res.destroy();
  }
});

// Image endpoint (simple)
app.get("/api/image/:id", async (req: Request, res: Response) => {
  try {
    state.recordRequest("/api/image");
    const media = state.getMedia(req.params.id as string);
    if (!media) return res.status(404).send("Image not found");
    if (media.type !== "photo")
      return res.status(400).send("This is not a photo");

    const message = await telegramManager.getMessage(
      media.chatId,
      media.messageId,
    );
    const buffer = await telegramManager.downloadChunk(
      message,
      media.fileSize,
      0,
      Math.max(0, media.fileSize - 1),
    );

    res.setHeader("Content-Type", media.mimeType || "image/jpeg");
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("ETag", `"${media.id}"`);
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
    if (!res.headersSent) res.status(500).send("Image download error");
    if (!res.destroyed) res.destroy();
  }
});

// ============================================================
// BOT HANDLERS
// - call prefetchInitialChunks immediately after saving media
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

      // Video
      if (message.video) {
        const video = message.video;
        const media: MediaRecord = {
          id: createMediaId(),
          fileId: video.file_id,
          chatId: String(ctx.chat.id),
          messageId: message.message_id,
          type: "video",
          fileSize: video.file_size ?? 0,
          mimeType: video.mime_type || "video/mp4",
          fileName: video.file_name || "video.mp4",
          width: video.width,
          height: video.height,
          duration: video.duration,
          createdAt: Date.now(),
          accessCount: 0,
        };

        state.addMedia(media);
        logMedia(media);

        // Immediately prefetch initial chunks
        prefetchInitialChunks(media).catch((err) =>
          logger.warn({ err, mediaId: media.id }, "Prefetch failed"),
        );

        const videoUrl = `${config.publicUrl}/api/video/${media.id}`;
        const sizeMB = ((video.file_size ?? 0) / 1024 / 1024).toFixed(2);
        await ctx.reply(
          `✅ Saqlandi\n\n🆔 ID: ${media.id}\n📦 Hajm: ${sizeMB} MB`,
          { reply_markup: createMediaButtons(videoUrl) },
        );
        return;
      }

      // Document (video file)
      if (message.document) {
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

        prefetchInitialChunks(media).catch((err) =>
          logger.warn({ err, mediaId: media.id }, "Prefetch failed"),
        );

        const videoUrl = `${config.publicUrl}/api/video/${media.id}`;
        await ctx.reply(
          `✅ Saqlandi\n\n🆔 ID: ${media.id}\n📦 Hajm: ${(media.fileSize / 1024 / 1024).toFixed(2)} MB`,
          { reply_markup: createMediaButtons(videoUrl) },
        );
        return;
      }

      // Photo
      if (message.photo) {
        const photos = message.photo;
        const photo = photos[photos.length - 1];
        if (!photo) throw new Error("Photo not found");
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

        // prefetch image first chunk (small)
        prefetchInitialChunks(media).catch((err) =>
          logger.warn({ err, mediaId: media.id }, "Prefetch image failed"),
        );

        const imageUrl = `${config.publicUrl}/api/image/${media.id}`;
        await ctx.reply(
          `✅ Saqlandi\n\n🆔 ID: ${media.id}\n📦 Hajm: ${(media.fileSize / 1024 / 1024).toFixed(2)} MB`,
          { reply_markup: createMediaButtons(imageUrl) },
        );
        return;
      }
    } catch (error) {
      logger.error(
        { error, stack: (error as Error).stack },
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

  bot.catch((err: any) => logger.error({ err }, "❌ Bot error"));
}

// ============================================================
// STARTUP & GRACEFUL SHUTDOWN
// ============================================================

const cacheCleanupInterval = setInterval(
  () => state.cleanExpiredCache(),
  5 * 60 * 1000,
);

async function start(): Promise<void> {
  try {
    logger.info("🚀 Starting Telegram Media Streaming API");
    telegramManager = new TelegramManager(
      config.token,
      config.apiId,
      config.apiHash,
    );
    await telegramManager.connect();
    setupBotHandlers(telegramManager);

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

    // start bot polling (grammy)
    telegramManager.getBot().start();
    logger.info("🤖 Telegram bot started");

    const graceful = async () => {
      logger.info("Shutting down...");
      try {
        server.close(() => logger.info("Server closed"));
      } catch (err) {
        logger.warn({ err }, "Error closing server");
      }
      try {
        clearInterval(cacheCleanupInterval);
      } catch {}
      try {
        telegramManager.getBot().stop();
      } catch {}
      process.exit(0);
    };

    process.on("SIGINT", graceful);
    process.on("SIGTERM", graceful);
  } catch (error) {
    logger.error({ error }, "❌ Startup failed");
    process.exit(1);
  }
}

// Error middleware LAST
app.use((err: any, req: Request, res: Response, next: any) => {
  logger.error({ error: err, path: req.path }, "Unhandled error");
  if (!res.headersSent) {
    res
      .status(500)
      .json({
        success: false,
        message: "Internal server error",
        error: process.env.NODE_ENV === "development" ? err.message : undefined,
      });
  }
});

start();
