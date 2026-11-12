import os
import unittest
from types import SimpleNamespace

from mtproto_worker import resolve_bot_token, worker_ready_endpoint_names
from worker_entities import find_dialog_entity


class WorkerConfigTests(unittest.TestCase):
    def test_prefers_telegram_bot_token_when_present(self) -> None:
        self.assertEqual(
            resolve_bot_token({'TELEGRAM_BOT_TOKEN': 'abc:token', 'BOT_TOKEN': 'legacy:token'}),
            'abc:token',
        )

    def test_exposes_health_and_ready_alias_endpoints(self) -> None:
        endpoints = worker_ready_endpoint_names()
        self.assertIn('/healthz', endpoints)
        self.assertIn('/readyz', endpoints)


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
