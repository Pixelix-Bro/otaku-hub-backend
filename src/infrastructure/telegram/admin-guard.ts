import { getConfig } from '../../config/env.js';
import { ForbiddenError } from '../../core/errors/app-error.js';

/**
 * Check if a Telegram user ID is an admin.
 */
export function isAdmin(userId: number): boolean {
  const config = getConfig();
  return config.adminTelegramIds.includes(userId);
}

/**
 * Require admin — throws ForbiddenError if not admin.
 */
export function requireAdmin(userId: number): void {
  if (!isAdmin(userId)) {
    throw new ForbiddenError('⛔ Sizda admin ruxsati mavjud emas.');
  }
}
