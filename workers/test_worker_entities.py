import unittest
from types import SimpleNamespace

from worker_entities import find_dialog_entity


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
