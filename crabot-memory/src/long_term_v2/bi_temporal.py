"""Bi-temporal helpers: relative time parsing for query pre-process."""
import calendar
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def to_iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_relative_window(
    expr: str, now: Optional[datetime] = None,
) -> Optional[Tuple[str, str]]:
    """Parse Chinese / English relative time expressions to (start, end) ISO-Z.

    Returns None if the expression is not a recognised relative window.
    """
    if not expr:
        return None
    e = expr.strip().lower()
    base = now or utc_now()

    day_start = base.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = day_start - timedelta(days=day_start.weekday())
    month_start = day_start.replace(day=1)
    _, days_in_month = calendar.monthrange(month_start.year, month_start.month)

    rules = {
        "今天": (day_start, timedelta(days=1)),
        "today": (day_start, timedelta(days=1)),
        "昨天": (day_start - timedelta(days=1), timedelta(days=1)),
        "yesterday": (day_start - timedelta(days=1), timedelta(days=1)),
        "本周": (week_start, timedelta(days=7)),
        "this week": (week_start, timedelta(days=7)),
        "上周": (week_start - timedelta(days=7), timedelta(days=7)),
        "last week": (week_start - timedelta(days=7), timedelta(days=7)),
        "本月": (month_start, timedelta(days=days_in_month)),
        "this month": (month_start, timedelta(days=days_in_month)),
        "最近三天": (base - timedelta(days=3), timedelta(days=3)),
        "last 3 days": (base - timedelta(days=3), timedelta(days=3)),
        "最近一周": (base - timedelta(days=7), timedelta(days=7)),
        "last 7 days": (base - timedelta(days=7), timedelta(days=7)),
    }
    if e in rules:
        start, span = rules[e]
        return to_iso_z(start), to_iso_z(start + span)
    return None
