import unittest

from range_math import align_download_window, slice_download_chunk


class RangeMathTests(unittest.TestCase):
    def test_aligns_unaligned_range_and_counts_covering_chunks(self) -> None:
        self.assertEqual(align_download_window(600_000, 900_000, 524_288), (524_288, 75_712, 2))

    def test_slices_leading_padding_and_requested_tail(self) -> None:
        data, skip, remaining = slice_download_chunk(b'abcdefgh', 3, 4)
        self.assertEqual(data, b'defg')
        self.assertEqual(skip, 0)
        self.assertEqual(remaining, 0)

    def test_carries_padding_across_chunks(self) -> None:
        first = slice_download_chunk(b'abcd', 6, 5)
        self.assertEqual(first, (b'', 2, 5))
        self.assertEqual(slice_download_chunk(b'efgh', first[1], first[2]), (b'gh', 0, 3))

    def test_rejects_invalid_download_window(self) -> None:
        with self.assertRaises(ValueError):
            align_download_window(-1, 10, 4096)
        with self.assertRaises(ValueError):
            align_download_window(0, 0, 4096)


if __name__ == '__main__':
    unittest.main()
