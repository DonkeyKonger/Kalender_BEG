def round_minutes_to_quarter_hour(minutes: int) -> int:
    """Round non-negative working minutes to the nearest quarter hour."""
    return ((minutes + 7) // 15) * 15
