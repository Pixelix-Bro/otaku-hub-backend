from typing import Any, Iterable


def find_dialog_entity(dialogs: Iterable[Any], chat_id: int) -> Any | None:
    for dialog in dialogs:
        if getattr(dialog, 'id', None) == chat_id:
            entity = getattr(dialog, 'entity', None)
            if entity is not None:
                return entity
    return None
