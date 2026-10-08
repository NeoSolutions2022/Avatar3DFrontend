# Pose downloads before the playback handoff

The widget now downloads the actual pose content while the preceding phrase
plays. Previously prefetch stopped at the API task response: Unity still had
to download the pose after the current phrase finished. Prepared content is
passed as an instance-local blob URL; the original URL remains the identity
used for replay and sharing between widgets.

The cache holds at most four files / 32 MiB, rejects individual files above
16 MiB, limits simultaneous downloads to two, and releases evicted blob URLs.
Optional warmup errors retain normal URL loading. Authorized controllers can
send `neotalk:prefetch-pose` with an existing pose descriptor to warm a mirrored
player without submitting another translation task. Existing controller and
same-origin URL checks still apply.

The initial byte-warmup change used the existing Elia .27 WebGL unchanged.
The .28 candidate additionally includes exact inadmissible-edge pruning in the
Unity pole solver (see `WIDGET-PPC-LATENCY-2026-10-08.md`). Full-clip preparation
and actual terminal-frame completion remain; gestures are not sped up or cut.

Measured A/B: three transitions in each version, same .27 runtime, original
AMIGO/APRENDER clips, 30 fps, controlled local API and 1200 ms pose response.
Median last-frame-to-next-start: 3641.6 ms before, 2671.5 ms after (26.6% lower).
Every execution reached its terminal frame; no uncaught browser exception.
This is not a 26.6% production SLA or a physical microphone/mobile certification.
Evidence is in the platform workspace `outputs/latency-ab.json` and the
reproducible harness `tmp/latency-ab.cjs`. Fifteen widget tests passed.
