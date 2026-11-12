import unittest

from chunk_cache import ChunkCache


class ChunkCacheTests(unittest.TestCase):
    def test_reads_recent_chunks_and_tracks_memory(self) -> None:
        cache = ChunkCache(8)
        cache.put('first', b'abcd')
        self.assertEqual(cache.get('first'), b'abcd')
        self.assertEqual(cache.current_bytes, 4)

    def test_evicts_least_recently_used_chunk_at_capacity(self) -> None:
        cache = ChunkCache(8)
        cache.put('first', b'abcd')
        cache.put('second', b'efgh')
        self.assertEqual(cache.get('first'), b'abcd')
        cache.put('third', b'ijkl')
        self.assertIsNone(cache.get('second'))
        self.assertEqual(cache.get('first'), b'abcd')
        self.assertEqual(cache.current_bytes, 8)

    def test_replacing_entry_and_oversized_chunk_respect_limit(self) -> None:
        cache = ChunkCache(4)
        cache.put('key', b'ab')
        cache.put('key', b'cde')
        self.assertEqual(cache.current_bytes, 3)
        cache.put('large', b'12345')
        self.assertIsNone(cache.get('large'))
        self.assertEqual(cache.current_bytes, 3)

    def test_zero_capacity_disables_cache(self) -> None:
        cache = ChunkCache(0)
        cache.put('key', b'data')
        self.assertIsNone(cache.get('key'))
        self.assertEqual(cache.current_bytes, 0)


if __name__ == '__main__':
    unittest.main()
