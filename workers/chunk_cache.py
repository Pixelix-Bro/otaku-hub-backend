from collections import OrderedDict


class ChunkCache:
    def __init__(self, max_bytes: int) -> None:
        if max_bytes < 0:
            raise ValueError('max_bytes must not be negative')
        self.max_bytes = max_bytes
        self.current_bytes = 0
        self._items: OrderedDict[str, bytes] = OrderedDict()

    def get(self, key: str) -> bytes | None:
        value = self._items.get(key)
        if value is not None:
            self._items.move_to_end(key)
        return value

    def put(self, key: str, value: bytes) -> None:
        if self.max_bytes == 0 or len(value) > self.max_bytes:
            return
        previous = self._items.pop(key, None)
        if previous is not None:
            self.current_bytes -= len(previous)
        self._items[key] = value
        self.current_bytes += len(value)
        while self.current_bytes > self.max_bytes:
            _, evicted = self._items.popitem(last=False)
            self.current_bytes -= len(evicted)
