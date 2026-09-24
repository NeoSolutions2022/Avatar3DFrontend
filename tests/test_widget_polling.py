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
def test_widget_retries_transient_sign_submission_without_sticky_error() -> None:
    assert "clearError();" in WIDGET_SOURCE
    assert "[408, 429, 500, 502, 503, 504].includes(error.status)" in WIDGET_SOURCE
    assert 'emitStatus("processing", { phrase, recovering: true })' in WIDGET_SOURCE


def test_widget_accepts_commands_after_moving_to_picture_in_picture() -> None:
    assert "const initialControllerWindow = window.parent;" in WIDGET_SOURCE
    assert "source === initialControllerWindow" in WIDGET_SOURCE
    assert "source === window.parent.opener" in WIDGET_SOURCE
    assert "controllerSourceAllowed(event.source)" in WIDGET_SOURCE
