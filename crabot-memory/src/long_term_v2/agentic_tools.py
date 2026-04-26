"""Step 5: Agentic fallback tools — exposed as RPCs for the agent to call directly."""
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional


class AgenticTools:
    def __init__(self, store, index):
        self.store = store
        self.index = index

    def grep_memory(
        self, pattern: str, type_: Optional[str] = None, limit: int = 20,
    ) -> List[Dict[str, Any]]:
        """Substring scan over `body` and `brief`. Cheap; no regex by design."""
        needle = pattern.lower()
        out: List[Dict[str, Any]] = []
        for mid, status, t, brief, body, ev, ing, path in self.index.iter_all_with_meta():
            if type_ and t != type_:
                continue
            if needle in (body or "").lower() or needle in (brief or "").lower():
                out.append({"id": mid, "type": t, "status": status, "brief": brief})
                if len(out) >= limit:
                    break
        return out

    def list_recent(
        self, window_days: int, type_: Optional[str] = None, limit: int = 20,
    ) -> List[Dict[str, Any]]:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=window_days)) \
            .isoformat().replace("+00:00", "Z")
        rows = []
        for mid, status, t, brief, body, ev, ing, path in self.index.iter_all_with_meta():
            if type_ and t != type_:
                continue
            if ev >= cutoff:
                rows.append((ev, {"id": mid, "type": t, "status": status, "brief": brief}))
        rows.sort(key=lambda x: x[0], reverse=True)
        return [r for _, r in rows[:limit]]

    def find_by_entity_brief(self, entity_id: str) -> List[Dict[str, Any]]:
        ids = self.index.find_by_entity(entity_id)
        return self._briefs_for(ids)

    def find_by_tag_brief(self, tag: str) -> List[Dict[str, Any]]:
        ids = self.index.find_by_tag(tag)
        return self._briefs_for(ids)

    def get_cases_about(self, scenario: str) -> List[Dict[str, Any]]:
        """Substring search lesson cases (single-occurrence lessons) over brief and body."""
        needle = scenario.lower()
        out = []
        for mid, status, t, brief, body, ev, ing, path in self.index.iter_all_with_meta():
            if t != "lesson":
                continue
            entry = self.store.read(status, t, mid)
            if entry.frontmatter.maturity != "case":
                continue
            if needle in (body or "").lower() or needle in (brief or "").lower():
                out.append({"id": mid, "type": t, "status": status, "brief": brief})
        return out

    def _briefs_for(self, ids: List[str]) -> List[Dict[str, Any]]:
        out = []
        for mid in ids:
            loc = self.index.locate(mid)
            if not loc:
                continue
            status, type_, _ = loc
            entry = self.store.read(status, type_, mid)
            out.append({"id": mid, "brief": entry.frontmatter.brief, "type": type_})
        return out
