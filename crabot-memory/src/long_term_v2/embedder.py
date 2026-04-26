"""Embedding helper for long_term v2."""
import numpy as np


def texts_for_entry(entry) -> dict:
    fm = entry.frontmatter
    tags_ents = " ".join(fm.tags + [e.name for e in fm.entities])
    return {
        "content": entry.body or fm.brief,
        "brief": fm.brief,
        "tags_entities": tags_ents,
    }


async def embed_text_async(text: str, embedder) -> np.ndarray:
    """Call the injected EmbeddingClient; returns a float32 1-D ndarray."""
    vec = await embedder.embed_single(text)
    return np.asarray(vec, dtype=np.float32)
