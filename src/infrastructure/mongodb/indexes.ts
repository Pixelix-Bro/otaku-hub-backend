import { getDb } from './client.js';
import { logger } from '../logger/logger.js';
import { COLLECTIONS } from '../../config/constants.js';

export async function createAllIndexes(): Promise<void> {
  const db = getDb();
  logger.info('📇 Creating MongoDB indexes...');

  // Media collection indexes
  const media = db.collection(COLLECTIONS.MEDIA);
  await media.createIndex({ mediaId: 1 }, { unique: true });
  await media.createIndex(
    { sourceChatId: 1, sourceMessageId: 1 },
    { unique: true },
  );
  await media.createIndex(
    { telegramFileUniqueId: 1 },
    { sparse: true },
  );
  await media.createIndex({ mediaType: 1 });
  await media.createIndex({ createdAt: -1 });
  await media.createIndex({ storageStatus: 1 });
  await media.createIndex({ deletedAt: 1 }, { sparse: true });
  await media.createIndex(
    { fileName: 'text', mediaId: 'text' },
    { name: 'media_search_index' },
  );

  // Bot updates collection indexes
  const botUpdates = db.collection(COLLECTIONS.BOT_UPDATES);
  await botUpdates.createIndex({ updateId: 1 }, { unique: true });
  await botUpdates.createIndex({ status: 1, createdAt: 1 });

  // Watch tokens collection indexes
  const watchTokens = db.collection(COLLECTIONS.WATCH_TOKENS);
  await watchTokens.createIndex({ tokenHash: 1 }, { unique: true });
  await watchTokens.createIndex({ mediaId: 1 });
  await watchTokens.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  logger.info('✅ All MongoDB indexes created');
}
