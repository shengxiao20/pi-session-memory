"""UTF-8 bounded, overlapping chunks with offsets into the complete role text."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Chunk:
    ordinal: int
    start: int
    end: int
    text: str


def document(turn):
    return f"User: {turn['user_text']}\n\nAssistant: {turn['reply_text']}"


def chunks(text, max_bytes=4096, overlap_bytes=512):
    if not 32 <= max_bytes <= 4096 or not 0 <= overlap_bytes <= max_bytes - 4:
        raise ValueError("chunk bytes must be 32..4096; overlap must be 0..chunk bytes minus 4")
    sizes = [len(character.encode("utf8")) for character in text]
    start = ordinal = 0
    while start < len(text):
        end, size = start, 0
        while end < len(text) and size + sizes[end] <= max_bytes:
            size += sizes[end]
            end += 1
        yield Chunk(ordinal, start, end, text[start:end])
        if end == len(text):
            return
        following, overlap = end, 0
        while following > start + 1 and overlap + sizes[following - 1] <= overlap_bytes:
            following -= 1
            overlap += sizes[following]
        start = following
        ordinal += 1
