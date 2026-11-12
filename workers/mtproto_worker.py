import base64
import hmac
import os
from typing import AsyncIterator, Protocol

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from telethon import TelegramClient
from telethon.errors import (
    FileReferenceExpiredError,
    FileReferenceInvalidError,
    FloodWaitError,
    RPCError,
    SessionRevokedError,
)

from chunk_cache import ChunkCache
from range_math import align_download_window, slice_download_chunk
from worker_entities import find_dialog_entity

load_dotenv()


def resolve_bot_token(env: dict[str, str] | None = None) -> str:
    values = os.environ if env is None else env
    return (values.get('TELEGRAM_BOT_TOKEN') or values.get('BOT_TOKEN') or '').strip()


def worker_ready_endpoint_names() -> tuple[str, ...]:
    return ('/healthz', '/health', '/readyz', '/ready')


def worker_secret_matches(provided: str | None, expected: str) -> bool:
    if not provided or not expected:
        return False
    return hmac.compare_digest(provided.encode('utf-8'), expected.encode('utf-8'))


def parse_integer_setting(name: str, value: str | None, default: int = 0) -> int:
    if value is None or value.strip() == '':
        return default
    try:
        return int(value)
    except ValueError:
        raise RuntimeError(f'{name} must be an integer.') from None


API_ID = parse_integer_setting('API_ID', os.getenv('API_ID'))
API_HASH = os.getenv('API_HASH', '')
BOT_TOKEN = resolve_bot_token()
SESSION_PATH = os.getenv('TELEGRAM_SESSION_PATH', '/data/xenvo_mtproto.session')
WORKER_SECRET = os.getenv('TELEGRAM_WORKER_SECRET', '')
STORAGE_CHAT_ID = parse_integer_setting('TELEGRAM_STORAGE_CHAT_ID', os.getenv('TELEGRAM_STORAGE_CHAT_ID'))
DEFAULT_CHUNK_BYTES = parse_integer_setting('STREAM_CHUNK_BYTES', os.getenv('STREAM_CHUNK_BYTES'), 524288)
CHUNK_CACHE_BYTES = parse_integer_setting(
    'MEDIA_CHUNK_CACHE_BYTES', os.getenv('MEDIA_CHUNK_CACHE_BYTES'), 64 * 1024 * 1024
)
MAX_ACTIVE_STREAMS = parse_integer_setting('MAX_ACTIVE_STREAMS', os.getenv('MAX_ACTIVE_STREAMS'), 10)

app = FastAPI(title='XENVO MTProto Worker', version='1.0.0')
client: TelegramClient | None = None
storage_entity: object | None = None
chunk_cache = ChunkCache(CHUNK_CACHE_BYTES)
active_streams = 0


class ClosableChunkIterator(Protocol):
    async def __anext__(self) -> bytes: ...

    async def close(self) -> None: ...


async def read_download_chunk(downloader: ClosableChunkIterator) -> bytes:
    try:
        return bytes(await downloader.__anext__())
    finally:
        await downloader.close()


@app.on_event('startup')
async def startup() -> None:
    global client, storage_entity
    if API_ID <= 0 or not API_HASH or not BOT_TOKEN or not WORKER_SECRET or not STORAGE_CHAT_ID:
        raise RuntimeError('MTProto worker requires API_ID, API_HASH, BOT_TOKEN, TELEGRAM_WORKER_SECRET, and TELEGRAM_STORAGE_CHAT_ID.')
    if DEFAULT_CHUNK_BYTES < 4096 or DEFAULT_CHUNK_BYTES > 524288 or DEFAULT_CHUNK_BYTES % 4096:
        raise RuntimeError('STREAM_CHUNK_BYTES must be a 4 KiB multiple between 4096 and 524288.')
    if CHUNK_CACHE_BYTES < 0 or MAX_ACTIVE_STREAMS < 1:
        raise RuntimeError('MEDIA_CHUNK_CACHE_BYTES must be non-negative and MAX_ACTIVE_STREAMS must be positive.')
    session_dir = os.path.dirname(SESSION_PATH)
    if session_dir:
        os.makedirs(session_dir, exist_ok=True)
    client = TelegramClient(SESSION_PATH, API_ID, API_HASH)
    await client.start(bot_token=BOT_TOKEN)
    storage_entity = await resolve_storage_entity(STORAGE_CHAT_ID)


@app.on_event('shutdown')
async def shutdown() -> None:
    if client is not None and client.is_connected():
        await client.disconnect()


async def resolve_storage_entity(chat_id: int) -> object:
    global storage_entity
    if client is None:
        raise HTTPException(status_code=503, detail='mtproto-worker-not-ready')
    if chat_id != STORAGE_CHAT_ID:
        raise HTTPException(status_code=403, detail='storage-chat-not-allowed')
    if storage_entity is not None:
        return storage_entity

    try:
        storage_entity = await client.get_input_entity(chat_id)
        return storage_entity
    except (ValueError, TypeError):
        dialogs = await client.get_dialogs()
        entity = find_dialog_entity(dialogs, chat_id)
        if entity is None:
            raise HTTPException(status_code=403, detail='storage-chat-not-accessible-to-mtproto-bot') from None
        storage_entity = await client.get_input_entity(entity)
        return storage_entity


@app.get('/health')
@app.get('/healthz')
async def health() -> dict[str, object]:
    return {
        'status': 'healthy',
        'service': 'xenvo-mtproto-worker',
        'telegram': {
            'connected': client is not None and client.is_connected(),
            'authorized': client is not None and client.is_connected(),
        },
        'storage': {'accessible': storage_entity is not None},
        'streaming': {'enabled': True},
    }


@app.get('/ready')
@app.get('/readyz')
async def ready(
    x_worker_secret: str | None = Header(default=None, alias='X-Worker-Secret'),
) -> dict[str, object]:
    if not worker_secret_matches(x_worker_secret, WORKER_SECRET):
        raise HTTPException(status_code=403, detail='invalid-worker-secret')
    if client is None or not client.is_connected() or storage_entity is None:
        raise HTTPException(status_code=503, detail='worker-not-ready')
    try:
        me = await client.get_me()
    except Exception:
        raise HTTPException(status_code=503, detail='telegram-not-ready') from None
    if me is None:
        raise HTTPException(status_code=503, detail='telegram-not-authorized')
    return {
        'status': 'ready',
        'service': 'xenvo-mtproto-worker',
        'telegram': {
            'connected': client.is_connected(),
            'authorized': True,
        },
        'storage': {'accessible': storage_entity is not None},
        'streaming': {'enabled': True},
        'bot_id': me.id,
    }


@app.get('/media-info')
async def media_info(
    chat_id: int,
    message_id: int,
    x_worker_secret: str | None = Header(default=None, alias='X-Worker-Secret'),
) -> dict[str, object]:
    if not worker_secret_matches(x_worker_secret, WORKER_SECRET):
        raise HTTPException(status_code=403, detail='invalid-worker-secret')
    if client is None:
        raise HTTPException(status_code=503, detail='mtproto-worker-not-ready')

    try:
        entity = await resolve_storage_entity(chat_id)
        message = await client.get_messages(entity, ids=message_id)
        if message is None or message.file is None or message.document is None:
            raise HTTPException(status_code=404, detail='source-message-has-no-document')
        document = message.document
        file_reference = getattr(document, 'file_reference', None)
        return {
            'file_size': int(message.file.size or 0),
            'file_name': message.file.name,
            'mime_type': message.file.mime_type,
            'document_id': str(document.id),
            'access_hash': str(document.access_hash),
            'dc_id': int(document.dc_id),
            'file_reference': base64.urlsafe_b64encode(file_reference).decode('ascii')
            if file_reference
            else None,
        }
    except HTTPException:
        raise
    except (FileReferenceExpiredError, FileReferenceInvalidError):
        raise HTTPException(status_code=409, detail='FILE_REFERENCE_EXPIRED') from None
    except FloodWaitError as exc:
        raise HTTPException(status_code=429, detail=f'FLOOD_WAIT:{exc.seconds}') from None
    except TimeoutError:
        raise HTTPException(status_code=504, detail='NETWORK_TIMEOUT') from None
    except RPCError as exc:
        error_name = type(exc).__name__
        if error_name in {'ChannelPrivateError', 'ChatAdminRequiredError', 'PeerIdInvalidError'}:
            raise HTTPException(status_code=403, detail='storage-chat-not-accessible-to-mtproto-bot') from None
        raise HTTPException(status_code=502, detail=f'TELEGRAM_RPC_ERROR:{error_name[:60]}') from None


@app.get('/media-range')
async def media_range(
    chat_id: int,
    message_id: int,
    offset: int = 0,
    limit: int = DEFAULT_CHUNK_BYTES,
    x_worker_secret: str | None = Header(default=None, alias='X-Worker-Secret'),
) -> StreamingResponse:
    global active_streams
    if not worker_secret_matches(x_worker_secret, WORKER_SECRET):
        raise HTTPException(status_code=403, detail='invalid-worker-secret')

    if client is None:
        raise HTTPException(status_code=503, detail='mtproto-worker-not-ready')
    if offset < 0 or limit < 1:
        raise HTTPException(status_code=416, detail='invalid-range')
    if MAX_ACTIVE_STREAMS < 1 or active_streams >= MAX_ACTIVE_STREAMS:
        raise HTTPException(status_code=503, detail='stream-capacity-reached')

    active_streams += 1
    stream_claimed = True

    def release_stream() -> None:
        nonlocal stream_claimed
        global active_streams
        if stream_claimed:
            active_streams -= 1
            stream_claimed = False

    try:
        entity = await resolve_storage_entity(chat_id)
        message = await client.get_messages(entity, ids=message_id)
        if message is None or message.file is None:
            raise HTTPException(status_code=404, detail='source-message-not-found')
        file_size = int(message.file.size or 0)
        if file_size <= 0 or offset >= file_size:
            raise HTTPException(status_code=416, detail='range-out-of-bounds')
        actual_limit = min(limit, file_size - offset)
        aligned_offset, prefix_bytes, _ = align_download_window(
            offset, actual_limit, DEFAULT_CHUNK_BYTES
        )

        async def stream_chunks() -> AsyncIterator[bytes]:
            position = aligned_offset
            skip = prefix_bytes
            remaining = actual_limit
            current_message = message
            refresh_attempts = 0

            try:
                while remaining > 0:
                    cache_key = f'{chat_id}:{message_id}:{position}'
                    chunk = chunk_cache.get(cache_key)
                    if chunk is None:
                        try:
                            if current_message.file is None:
                                raise HTTPException(status_code=404, detail='source-file-unavailable')
                            downloader = client.iter_download(
                                current_message.file,
                                offset=position,
                                limit=1,
                                chunk_size=DEFAULT_CHUNK_BYTES,
                                request_size=DEFAULT_CHUNK_BYTES,
                            )
                            chunk = await read_download_chunk(downloader)
                        except StopAsyncIteration:
                            raise HTTPException(status_code=502, detail='telegram-range-ended-early') from None
                        except (FileReferenceExpiredError, FileReferenceInvalidError):
                            refresh_attempts += 1
                            if refresh_attempts > 2:
                                raise HTTPException(status_code=409, detail='FILE_REFERENCE_EXPIRED') from None
                            entity = await resolve_storage_entity(chat_id)
                            current_message = await client.get_messages(entity, ids=message_id)
                            if current_message is None or current_message.file is None:
                                raise HTTPException(status_code=404, detail='source-message-not-found') from None
                            continue
                        if not chunk:
                            raise HTTPException(status_code=502, detail='telegram-range-ended-early')
                        chunk_cache.put(cache_key, chunk)

                    position += len(chunk)
                    part, skip, remaining = slice_download_chunk(chunk, skip, remaining)
                    if part:
                        yield part
            finally:
                release_stream()

        return StreamingResponse(
            stream_chunks(),
            media_type='application/octet-stream',
            status_code=206,
            headers={
                'Accept-Ranges': 'bytes',
                'Content-Length': str(actual_limit),
                'Content-Range': f'bytes {offset}-{offset + actual_limit - 1}/{file_size}',
            },
        )
    except HTTPException:
        release_stream()
        raise
    except (FileReferenceExpiredError, FileReferenceInvalidError):
        release_stream()
        raise HTTPException(status_code=409, detail='FILE_REFERENCE_EXPIRED') from None
    except SessionRevokedError:
        release_stream()
        raise HTTPException(status_code=401, detail='SESSION_REVOKED') from None
    except FloodWaitError as exc:
        release_stream()
        raise HTTPException(status_code=429, detail=f'FLOOD_WAIT:{exc.seconds}') from None
    except TimeoutError:
        release_stream()
        raise HTTPException(status_code=504, detail='NETWORK_TIMEOUT') from None
    except RPCError as exc:
        release_stream()
        error_name = type(exc).__name__
        if error_name in {'ChannelPrivateError', 'ChatAdminRequiredError', 'PeerIdInvalidError'}:
            raise HTTPException(status_code=403, detail='storage-chat-not-accessible-to-mtproto-bot') from None
        raise HTTPException(status_code=502, detail=f'TELEGRAM_RPC_ERROR:{error_name[:60]}') from None
    except Exception:
        release_stream()
        raise
