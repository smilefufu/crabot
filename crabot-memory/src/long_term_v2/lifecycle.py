"""Controlled long-term memory status transitions."""
from .paths import entry_path


def move_entry(
    store,
    index,
    entry,
    *,
    from_status: str,
    to_status: str,
    now_iso: str,
    target_frontmatter_updates: dict | None = None,
):
    """Move an entry and keep frontmatter plus SQLite aligned.

    File storage and SQLite cannot share a transaction. If indexing fails after the
    move, compensate by restoring the original file and index row before raising.
    ``target_frontmatter_updates`` is written only at the destination, so that
    compensation always restores the unmodified source entry.
    """
    if from_status == to_status:
        return entry

    if to_status == "inbox":
        updates = {"inbox_entered_at": now_iso, "trashed_at": None}
    elif to_status == "trash":
        updates = {"inbox_entered_at": None, "trashed_at": now_iso}
    else:
        updates = {"inbox_entered_at": None, "trashed_at": None}
    if target_frontmatter_updates:
        updates.update(target_frontmatter_updates)

    new_entry = entry.model_copy(update={
        "frontmatter": entry.frontmatter.model_copy(update=updates),
    })
    fm = entry.frontmatter
    store.move(fm.id, fm.type, from_status=from_status, to_status=to_status)
    try:
        store.write(new_entry, status=to_status)
        index.upsert(
            new_entry,
            path=entry_path(store.data_root, to_status, fm.type, fm.id),
            status=to_status,
        )
    except Exception:
        try:
            store.move(fm.id, fm.type, from_status=to_status, to_status=from_status)
            store.write(entry, status=from_status)
            index.upsert(
                entry,
                path=entry_path(store.data_root, from_status, fm.type, fm.id),
                status=from_status,
            )
        except Exception:
            pass
        raise
    return new_entry
