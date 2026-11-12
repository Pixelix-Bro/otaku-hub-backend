import type { ObjectId } from 'mongodb';
import type { MediaType, StorageStatus, Visibility } from '../../config/constants.js';

// ─── MongoDB Document Shapes ─────────────────────────────────

export interface MediaDocument {
  _id?: ObjectId;
  mediaId: string;
  mediaType: MediaType;
  fileName: string | null;
  mimeType: string | null;
  extension: string | null;
  sizeBytes: number | null;
  telegramFileId: string | null;
  telegramFileUniqueId: string | null;
  sourceChatId: string;
  sourceMessageId: number;
  storageChatId: string;
  storageMessageId: number | null;
  mediaGroupId: string | null;
  caption: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  visibility: Visibility;
  storageStatus: StorageStatus;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface BotUpdateDocument {
  _id?: ObjectId;
  updateId: number;
  status: 'pending' | 'processing' | 'processed' | 'failed';
  attempts: number;
  messageType: string | null;
  chatId: string | null;
  createdAt: Date;
  processedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface WatchTokenDocument {
  _id?: ObjectId;
  tokenHash: string;
  mediaId: string;
  expiresAt: Date;
  maxUses: number;
  usedCount: number;
  createdAt: Date;
}

// ─── Telegram API Types ──────────────────────────────────────

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  thumbnail?: TelegramPhotoSize;
}

export interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  thumbnail?: TelegramPhotoSize;
}

export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAnimation {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideoNote {
  file_id: string;
  file_unique_id: string;
  length: number;
  duration: number;
  file_size?: number;
}

export interface TelegramSticker {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  is_animated: boolean;
  is_video: boolean;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  video?: TelegramVideo;
  document?: TelegramDocument;
  audio?: TelegramAudio;
  animation?: TelegramAnimation;
  voice?: TelegramVoice;
  video_note?: TelegramVideoNote;
  sticker?: TelegramSticker;
  media_group_id?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    message?: TelegramMessage;
    data?: string;
  };
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
  };
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

// ─── API Response Types ──────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface MediaMetadataResponse {
  mediaId: string;
  mediaType: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  formattedSize: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  status: string;
  telegramWatchUrl: string | null;
  webPreviewUrl: string | null;
  createdAt: string;
}

// ─── Extracted Media Info ────────────────────────────────────

export interface ExtractedMediaInfo {
  type: MediaType;
  fileId: string;
  fileUniqueId: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  mediaGroupId: string | null;
}
