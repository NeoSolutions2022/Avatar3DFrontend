import json
import re
from pathlib import Path


WIDGET_SOURCE = (
    Path(__file__).resolve().parents[1] / "frontend" / "widget.js"
).read_text(encoding="utf-8")


def test_widget_uses_progressive_task_polling() -> None:
    match = re.search(
        r"const pollScheduleMs = (\[[^;]+\]);",
        WIDGET_SOURCE,
    )

    assert match is not None
    assert json.loads(match.group(1)) == [0, 300, 500, 800, 1200]
    assert "const delayMs = pollDelayForAttempt(attempt);" in WIDGET_SOURCE
    assert "if (delayMs > 0) await wait(delayMs);" in WIDGET_SOURCE
    assert "await wait(pollIntervalMs);" not in WIDGET_SOURCE


def test_widget_keeps_the_last_delay_after_the_ramp() -> None:
    assert (
        "pollScheduleMs[Math.min(attempt, pollScheduleMs.length - 1)]"
        in WIDGET_SOURCE
    )
