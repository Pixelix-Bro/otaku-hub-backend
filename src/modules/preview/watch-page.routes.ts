import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'

import { isValidMediaId } from '../../core/utils/index.js'
import { getMediaById } from '../media/media.service.js'
import { WatchTokenRepository } from '../watch/watch-token.repository.js'
import { hashWatchToken, isWatchTokenExpired } from '../watch/watch-token.service.js'

const watchTokens = new WatchTokenRepository()

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return entities[character]!
  })
}

export async function watchPageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/watch/:mediaId', async (request, reply) => {
    const { mediaId } = request.params as { mediaId: string }
    const { token } = request.query as { token?: string }
    if (!isValidMediaId(mediaId)) {
      return reply.code(400).send({ ok: false, error: 'Invalid media ID' })
    }
    if (!token || token.length > 62 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      return reply.code(401).send({ ok: false, error: 'Valid watch token required' })
    }

    const tokenHash = hashWatchToken(token)
    const tokenRecord = await watchTokens.findByHash(tokenHash)
    if (
      !tokenRecord ||
      tokenRecord.mediaId !== mediaId ||
      isWatchTokenExpired(tokenRecord.expiresAt)
    ) {
      return reply.code(403).send({ ok: false, error: 'Watch link is invalid or expired' })
    }

    const media = await getMediaById(mediaId)
    if (!media || media.storageStatus !== 'stored' || media.storageMessageId === null) {
      return reply.code(404).send({ ok: false, error: 'Stored media not found' })
    }
    if (media.mediaType !== 'video' && !media.mimeType?.startsWith('video/')) {
      return reply.code(415).send({ ok: false, error: 'This media is not a browser video' })
    }
    const claimedToken = await watchTokens.consumeIfUsable(tokenHash)
    if (!claimedToken || claimedToken.mediaId !== mediaId) {
      return reply.code(403).send({ ok: false, error: 'Watch link use limit reached or expired' })
    }

    const nonce = randomBytes(18).toString('base64')
    const title = escapeHtml(media.fileName ?? media.mediaId)
    const streamUrl = `/api/stream/${encodeURIComponent(mediaId)}?token=${encodeURIComponent(token)}`
    reply.header('Cache-Control', 'private, no-store')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header(
      'Content-Security-Policy',
      `default-src 'none'; media-src 'self'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`
    )

    return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="uz">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${title}</title>
  <style nonce="${nonce}">html,body{margin:0}video{display:block;width:100%;height:auto;max-height:100vh;background:#000}</style>
</head>
<body>
  <video controls playsinline preload="metadata" src="${streamUrl}" aria-label="${title}"></video>
</body>
</html>`)
  })
}
