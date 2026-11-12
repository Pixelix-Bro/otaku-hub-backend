export const MEDIA_TYPES = {
  VIDEO: 'video',
  DOCUMENT: 'document',
  AUDIO: 'audio',
  PHOTO: 'photo',
  ANIMATION: 'animation',
  VOICE: 'voice',
  VIDEO_NOTE: 'video_note',
  STICKER: 'sticker',
} as const;

export type MediaType = (typeof MEDIA_TYPES)[keyof typeof MEDIA_TYPES];

export const STORAGE_STATUS = {
  PENDING: 'pending',
  COPYING: 'copying',
  STORED: 'stored',
  COPY_FAILED: 'copy_failed',
  COPY_UNKNOWN: 'copy_unknown',
  DELETED: 'deleted',
} as const;

export type StorageStatus = (typeof STORAGE_STATUS)[keyof typeof STORAGE_STATUS];

export const VISIBILITY = {
  PUBLIC: 'public',
  PRIVATE: 'private',
} as const;

export type Visibility = (typeof VISIBILITY)[keyof typeof VISIBILITY];

export const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mov', 'mkv', 'avi', 'webm', 'mpeg', 'mpg',
  'ts', 'mts', 'm2ts', 'flv', '3gp',
]);

export const DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'zip', 'rar', '7z',
]);

export const AUDIO_EXTENSIONS = new Set([
  'mp3', 'aac', 'm4a', 'flac', 'wav', 'ogg', 'opus',
]);

export const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'tiff', 'bmp',
]);

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const;

export const COLLECTIONS = {
  MEDIA: 'media',
  BOT_UPDATES: 'bot_updates',
  WATCH_TOKENS: 'watch_tokens',
} as const;
