from math import ceil


def align_download_window(offset: int, length: int, chunk_size: int) -> tuple[int, int, int]:
    if offset < 0 or length < 1 or chunk_size < 1:
        raise ValueError('offset, length, and chunk_size must be positive')
    aligned_offset = (offset // chunk_size) * chunk_size
    prefix_bytes = offset - aligned_offset
    chunk_count = ceil((prefix_bytes + length) / chunk_size)
    return aligned_offset, prefix_bytes, chunk_count


def slice_download_chunk(chunk: bytes, skip: int, remaining: int) -> tuple[bytes, int, int]:
    skipped = min(skip, len(chunk))
    next_skip = skip - skipped
    data = chunk[skipped : skipped + remaining]
    return data, next_skip, remaining - len(data)
