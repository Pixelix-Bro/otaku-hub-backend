import { COLLECTIONS } from '../../config/constants.js'
import { logger } from '../../infrastructure/logger/logger.js'
import { getCollection } from '../../infrastructure/mongodb/client.js'

export interface AdminAuditEvent {
  eventType: string
  adminTelegramId: number
  mediaId?: string
  result: 'success' | 'failure' | 'denied'
  createdAt: Date
}

export async function recordAdminAudit(event: Omit<AdminAuditEvent, 'createdAt'>): Promise<void> {
  try {
    await getCollection<AdminAuditEvent>(COLLECTIONS.ADMIN_AUDIT).insertOne({
      ...event,
      createdAt: new Date(),
    })
  } catch {
    logger.error(
      { eventType: event.eventType, adminTelegramId: event.adminTelegramId },
      'Admin audit write failed'
    )
  }
}
