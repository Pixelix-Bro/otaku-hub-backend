import os
from typing import AsyncIterator

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from telethon import TelegramClient
from telethon.errors import FloodWaitError, FileReferenceExpiredError, SessionRevokedError

API_ID = int(os.getenv('API_ID', '0') or 0)
API_HASH = os.getenv('API_HASH', '')
BOT_TOKEN = os.getenv('BOT_TOKEN', '')
SESSION_PATH = os.getenv('TELEGRAM_SESSION_PATH', '/data/xenvo_mtproto.session')
WORKER_SECRET = os.getenv('TELEGRAM_WORKER_SECRET', '')
DEFAULT_CHUNK_BYTES = int(os.getenv('STREAM_CHUNK_BYTES', '524288'))

app = FastAPI(title='XENVO MTProto Worker', version='1.0.0')
client: TelegramClient | None = None


@app.on_event('startup')
async def startup() -> None:
    global client
    if not API_ID or not API_HASH or not BOT_TOKEN:
        raise RuntimeError('MTProto worker requires API_ID, API_HASH and BOT_TOKEN in the environment.')
    client = TelegramClient(SESSION_PATH, API_ID, API_HASH)
    await client.start(bot_token=BOT_TOKEN)


@app.get('/health')
async def health() -> dict[str, object]:
    return {'ok': True, 'status': 'healthy'}


@app.get('/ready')
async def ready() -> dict[str, object]:
    if client is None:
        raise HTTPException(status_code=503, detail='worker-not-ready')
    return {'ok': True, 'status': 'ready', 'bot_id': (await client.get_me()).id}


@app.get('/media-range')
async def media_range(
    chat_id: int,
    message_id: int,
    offset: int = 0,
    limit: int = DEFAULT_CHUNK_BYTES,
    x_worker_secret: str | None = Header(default=None, alias='X-Worker-Secret'),
) -> StreamingResponse:
    if WORKER_SECRET and x_worker_secret != WORKER_SECRET:
        raise HTTPException(status_code=403, detail='invalid-worker-secret')

    if client is None:
        raise HTTPException(status_code=503, detail='mtproto-worker-not-ready')

    try:
        message = await client.get_messages(chat_id, ids=message_id)
        if message is None or message.file is None:
            raise HTTPException(status_code=404, detail='source-message-not-found')

        async def stream_chunks() -> AsyncIterator[bytes]:
            async for chunk in client.iter_download(message.file, offset=offset, limit=limit):
                yield chunk

        return StreamingResponse(
            stream_chunks(),
            media_type='application/octet-stream',
            headers={
                'Accept-Ranges': 'bytes',
                'Content-Range': f'bytes {offset}-{offset + max(limit, 0) - 1}/*',
            },
        )
    except FileReferenceExpiredError:
        raise HTTPException(status_code=409, detail='FILE_REFERENCE_EXPIRED') from None
    except SessionRevokedError:
        raise HTTPException(status_code=401, detail='SESSION_REVOKED') from None
    except FloodWaitError as exc:
        raise HTTPException(status_code=429, detail=f'FLOOD_WAIT:{exc.seconds}') from None
    except TimeoutError:
        raise HTTPException(status_code=504, detail='NETWORK_TIMEOUT') from None
