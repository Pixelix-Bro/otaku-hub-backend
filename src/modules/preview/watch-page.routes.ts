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
    const mimeType =
      media.mimeType && /^video\/[\w.+-]+$/.test(media.mimeType) ? media.mimeType : 'video/mp4'
    const streamUrl = `/api/stream/${encodeURIComponent(mediaId)}?token=${encodeURIComponent(token)}`
    reply.header('Cache-Control', 'private, no-store')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header(
      'Content-Security-Policy',
      `default-src 'none'; media-src 'self'; connect-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    )

    return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="uz">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${title} | XENVO</title>
  <style nonce="${nonce}">
    :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101416;color:#f4f6f5}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 50% 0,#22312b 0,transparent 58%),#101416}
    main{width:min(1120px,100%);margin:auto;padding:clamp(16px,4vw,48px)}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}
    .brand{font-weight:800;color:#c1f06b;text-decoration:none}.title{font-size:20px;overflow-wrap:anywhere;margin:0}
    .stage{background:#050606;border:1px solid #39433d;border-radius:8px;overflow:hidden;aspect-ratio:16/9;display:grid;place-items:center}
    video{width:100%;height:100%;object-fit:contain;background:#050606}footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:16px;flex-wrap:wrap}
    .status{color:#c3ccc5;min-height:24px}.controls{display:flex;align-items:center;gap:8px}button,select{font:inherit;color:#f4f6f5;background:#202927;border:1px solid #536159;border-radius:6px;padding:8px 12px}
    button{cursor:pointer}button:hover,select:hover{border-color:#c1f06b}button:focus-visible,select:focus-visible{outline:2px solid #c1f06b;outline-offset:2px}
    @media(max-width:600px){header{align-items:flex-start}.title{font-size:18px}.stage{aspect-ratio:9/16}footer{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body>
  <main>
    <header><a class="brand" href="/">XENVO</a><h1 class="title">${title}</h1></header>
    <div class="stage"><video id="player" controls playsinline preload="metadata" aria-label="${title}"><source src="${streamUrl}" type="${escapeHtml(mimeType)}">Brauzeringiz ushbu video formatini qo‘llab-quvvatlamaydi.</video></div>
    <footer><span id="status" class="status" role="status" aria-live="polite">Video yuklanmoqda…</span>
      <div class="controls"><label for="speed">Tezlik</label><select id="speed"><option value="0.5">0.5x</option><option value="0.75">0.75x</option><option value="1" selected>1x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2x</option></select><button id="fullscreen" type="button">To‘liq ekran</button></div>
    </footer>
  </main>
  <script nonce="${nonce}">
    const player=document.getElementById('player');const status=document.getElementById('status');
    document.getElementById('speed').addEventListener('change',event=>{player.playbackRate=Number(event.target.value)});
    document.getElementById('fullscreen').addEventListener('click',()=>{if(document.fullscreenElement){document.exitFullscreen()}else{player.requestFullscreen?.()}});
    player.addEventListener('playing',()=>{status.textContent='Ijro etilmoqda'});
    player.addEventListener('waiting',()=>{status.textContent='Video yuklanmoqda…'});
    player.addEventListener('stalled',()=>{status.textContent='Aloqa sekinlashdi, qayta urinilmoqda…'});
    player.addEventListener('canplay',()=>{status.textContent='Ijroga tayyor'});
    player.addEventListener('error',()=>{status.textContent='Video ochilmadi. Format yoki ulanishni tekshiring.'});
  </script>
</body>
</html>`)
  })
}
