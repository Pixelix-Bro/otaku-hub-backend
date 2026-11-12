import os
import unittest
from types import SimpleNamespace

from mtproto_worker import (
    parse_integer_setting,
    read_download_chunk,
    resolve_bot_token,
    worker_ready_endpoint_names,
    worker_secret_matches,
)
from worker_entities import find_dialog_entity


class WorkerConfigTests(unittest.TestCase):
    def test_integer_settings_report_the_variable_name_for_placeholders(self) -> None:
        self.assertEqual(parse_integer_setting('API_ID', '12345'), 12345)
        self.assertEqual(parse_integer_setting('PORT', None, 8000), 8000)
        with self.assertRaisesRegex(RuntimeError, 'API_ID must be an integer'):
            parse_integer_setting('API_ID', '<Telegram API ID raqami>')

    def test_worker_secret_check_rejects_missing_or_mismatched_values(self) -> None:
        self.assertTrue(worker_secret_matches('shared-secret', 'shared-secret'))
        self.assertFalse(worker_secret_matches(None, 'shared-secret'))
        self.assertFalse(worker_secret_matches('', 'shared-secret'))
        self.assertFalse(worker_secret_matches('wrong-secret', 'shared-secret'))

    def test_prefers_telegram_bot_token_when_present(self) -> None:
        self.assertEqual(
            resolve_bot_token({'TELEGRAM_BOT_TOKEN': 'abc:token', 'BOT_TOKEN': 'legacy:token'}),
            'abc:token',
        )

    def test_exposes_health_and_ready_alias_endpoints(self) -> None:
        endpoints = worker_ready_endpoint_names()
        self.assertIn('/healthz', endpoints)
        self.assertIn('/readyz', endpoints)


class DownloadIteratorTests(unittest.IsolatedAsyncioTestCase):
    async def test_closes_iterator_after_a_successful_chunk(self) -> None:
        iterator = FakeChunkIterator(b'chunk')
        self.assertEqual(await read_download_chunk(iterator), b'chunk')
        self.assertTrue(iterator.closed)

    async def test_closes_iterator_when_reading_raises(self) -> None:
        iterator = FakeChunkIterator(error=RuntimeError('telegram read failed'))
        with self.assertRaisesRegex(RuntimeError, 'telegram read failed'):
            await read_download_chunk(iterator)
        self.assertTrue(iterator.closed)


class FakeChunkIterator:
    def __init__(self, value: bytes = b'', error: Exception | None = None) -> None:
        self.value = value
        self.error = error
        self.closed = False

    async def __anext__(self) -> bytes:
        if self.error is not None:
            raise self.error
        return self.value

    async def close(self) -> None:
        self.closed = True


class WorkerEntityTests(unittest.TestCase):
    def test_selects_entity_for_exact_telegram_chat_id(self) -> None:
        wanted = object()
        dialogs = [
            SimpleNamespace(id=-10010, entity=object()),
            SimpleNamespace(id=-10020, entity=wanted),
        ]
        self.assertIs(find_dialog_entity(dialogs, -10020), wanted)

    def test_rejects_missing_or_entityless_dialog(self) -> None:
        dialogs = [SimpleNamespace(id=-10010, entity=None)]
        self.assertIsNone(find_dialog_entity(dialogs, -10010))
        self.assertIsNone(find_dialog_entity(dialogs, -10020))


if __name__ == '__main__':
    unittest.main()
