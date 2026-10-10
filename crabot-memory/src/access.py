"""Trusted Memory context and coarse visibility, independent of source scopes."""
import json
import yaml

from pydantic import ValidationError

from .types import MemoryAccessContext

MEMORY_DATA_METHODS = frozenset({
    "write_short_term", "search_short_term", "batch_write_short_term", "write_long_term", "search_long_term",
    "get_memory", "delete_memory", "update_memory", "update_long_term", "quick_capture", "grep_memory",
    "list_recent", "find_by_entity", "find_by_tag", "get_cases_about", "list_entries", "keyword_search",
    "get_entry_version", "promote_inbox_entry", "promote_to_rule", "get_confirmed_snapshot", "bump_lesson_use",
    "report_task_feedback", "get_observation_pending", "mark_observation_pass", "extend_observation_window",
    "upsert_scene_profile", "get_scene_profile", "delete_scene_profile", "list_scene_profiles", "list_scene_profiles_by_memory",
    "get_stats", "get_evolution_mode", "set_evolution_mode", "get_reflection_watermark", "update_reflection_watermark",
    "get_memory_graph", "run_maintenance", "trigger_consolidation", "export_memories", "import_memories", "import_long_term",
    "restore_memory", "preview_historical_inbox", "migrate_historical_inbox_batch",
})
_REFLECTION_METHODS = frozenset({
    "search_short_term", "search_long_term", "get_memory", "quick_capture", "update_long_term", "update_memory",
    "delete_memory", "list_recent", "list_entries", "promote_inbox_entry", "promote_to_rule", "get_stats",
    "get_evolution_mode", "set_evolution_mode", "get_reflection_watermark", "update_reflection_watermark",
})
_GRAPH_METHODS = frozenset({"list_entries", "search_long_term", "get_memory", "update_long_term", "update_memory"})
_ADMIN_METHODS = frozenset({"export_memories", "import_memories", "import_long_term", "restore_memory", "preview_historical_inbox", "migrate_historical_inbox_batch", "run_maintenance"})
_GLOBAL_METHODS = _ADMIN_METHODS | {"get_stats", "get_evolution_mode", "set_evolution_mode", "get_reflection_watermark", "update_reflection_watermark", "get_memory_graph", "trigger_consolidation", "list_scene_profiles", "list_scene_profiles_by_memory"}



class MemoryAccessError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def access_context(params: dict, *, required: bool = False) -> MemoryAccessContext:
    raw = params.get("access_context")
    if raw is None:
        if required:
            raise MemoryAccessError("UNAUTHORIZED", "Missing Memory access context")
        # Internal handler calls have no elevated identity; HTTP requires context.
        raw = {"actor_kind": "conversation", "memory_enabled": True}
    try:
        context = MemoryAccessContext.model_validate(raw)
    except ValidationError:
        raise MemoryAccessError("INVALID_PARAMS", "Invalid Memory access context") from None
    if not context.memory_enabled:
        raise MemoryAccessError("FORBIDDEN", "Memory is disabled")
    return context


def validate_scopes(raw) -> list[str]:
    if not isinstance(raw, list) or any(not isinstance(s, str) or not s.strip() for s in raw):
        raise MemoryAccessError("INVALID_PARAMS", "scopes must be a string array")
    return raw


def authorize_method(method: str, params: dict) -> MemoryAccessContext:
    context = access_context(params, required=True)
    actor = context.actor_kind
    if (actor == "conversation" and method in _GLOBAL_METHODS
        or actor == "master_private" and method in _ADMIN_METHODS
        or actor == "builtin_reflection" and method not in _REFLECTION_METHODS
        or actor == "builtin_graph_rebuild" and method not in _GRAPH_METHODS
        or actor == "mechanical" and method != "run_maintenance"):
        raise MemoryAccessError("FORBIDDEN", "Memory method is unavailable for this actor")
    if actor == "builtin_graph_rebuild" and method in {"update_long_term", "update_memory"} and set(params.get("patch") or {}) != {"links"}:
        raise MemoryAccessError("FORBIDDEN", "Graph rebuild can only update links")
    if method in {"write_short_term", "write_long_term", "quick_capture", "batch_write_short_term"}:
        writes = params.get("entries", []) if method == "batch_write_short_term" else [params]
        for write in writes:
            if not isinstance(write, dict) or not isinstance(write.get("visibility"), str) or write["visibility"] not in {"private", "internal", "public"} or "scopes" not in write:
                raise MemoryAccessError("INVALID_PARAMS", "New writes require visibility and scopes")
            validate_scopes(write["scopes"])
            if actor == "conversation" and write["visibility"] == "private":
                raise MemoryAccessError("FORBIDDEN", "Private write requires trusted identity")
    if actor == "conversation" and method in {"get_scene_profile", "upsert_scene_profile", "delete_scene_profile"}:
        try:
            scene = params["scene"]
            if context.scene is None or scene != context.scene.model_dump():
                raise MemoryAccessError("FORBIDDEN", "Scene does not match trusted target")
        except KeyError:
            raise MemoryAccessError("INVALID_PARAMS", "Missing scene") from None
    return context


class MemoryReader:
    """Request-local reads, including file/index agreement and safe references."""
    def __init__(self, store, index, params: dict):
        self.store, self.index = store, index
        self.context = access_context(params)
        self.private = self.context.actor_kind != "conversation"
        self.minimum = params.get("min_visibility")
        if self.minimum is not None and (not isinstance(self.minimum, str) or self.minimum not in {"private", "internal", "public"}):
            raise MemoryAccessError("INVALID_PARAMS", "Invalid min_visibility")
        if self.minimum == "private" and not self.private:
            raise MemoryAccessError("FORBIDDEN", "Private memory requires trusted identity")
        raw_scopes = params.get("accessible_scopes")
        self.scopes = validate_scopes(raw_scopes) if raw_scopes is not None else []
        self._entries = {}

    def permits(self, visibility: str, scopes: list[str]) -> bool:
        if visibility not in {"private", "internal", "public"}:
            return False
        if visibility == "private" and not self.private:
            return False
        if self.minimum == "public" and visibility != "public":
            return False
        if self.minimum == "internal" and visibility == "private":
            return False
        return not self.scopes or bool(set(scopes).intersection(self.scopes))

    def read(self, mid: str):
        if mid in self._entries:
            return self._entries[mid]
        result = None
        row = self.index.get_row(mid)
        if row is not None:
            try:
                scopes = validate_scopes(json.loads(row["scopes"]))
                if self.permits(row["visibility"], scopes):
                    entry = self.store.read(row["status"], row["type"], mid)
                    fm = entry.frontmatter
                    if fm.visibility == row["visibility"] and set(fm.scopes) == set(scopes):
                        result = (row["status"], row["type"], entry)
            except (ValueError, TypeError, FileNotFoundError, MemoryAccessError, yaml.YAMLError):
                pass  # Invalid metadata never exposes the possibly private body.
        self._entries[mid] = result
        return result

    def ids(self) -> set[str]:
        return {r[0] for r in self.index.conn.execute("SELECT id FROM memories").fetchall() if self.read(r[0]) is not None}

    def version_visible(self, reference: str) -> bool:
        mid, _, version = reference.partition("#v")
        current = self.read(mid)
        if not current:
            return False
        if not version:
            return True
        try:
            archived = self.store.read_version(current[0], current[1], mid, int(version))
            return self.permits(archived.frontmatter.visibility, archived.frontmatter.scopes)
        except (ValueError, TypeError, FileNotFoundError, yaml.YAMLError):
            return False

    def project(self, entry) -> dict:
        fm = entry.frontmatter.model_dump(exclude_none=True, mode="json")
        fm["links"] = [link for link in fm.get("links", []) if self.read(link["target"])]
        if fm.get("invalidated_by") and not self.read(fm["invalidated_by"]):
            del fm["invalidated_by"]
        if fm.get("lesson_meta"):
            fm["lesson_meta"]["source_cases"] = [mid for mid in fm["lesson_meta"].get("source_cases", []) if self.read(mid)]
        fm["prev_version_ids"] = [ref for ref in fm.get("prev_version_ids", []) if self.version_visible(ref)]
        return fm
