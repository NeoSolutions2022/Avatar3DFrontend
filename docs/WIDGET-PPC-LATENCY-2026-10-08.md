# Elia .28: exact preparation work pruning

The former pole optimizer evaluated all 49^3 predecessor transitions per frame,
including edges already excluded by the projection gate and paths with infinite
cost. The candidate skips only those impossible paths. It retains 49 candidates,
the cost function, ascending tie order, solver GN, source sampling, visual V11
profile, original poses and actual terminal-frame completion.

The .28 WebGL was built from the existing approved ELIARuntime scene into a fresh
directory. Build exit 0; no resource guard interruption. Protected scene,
retargeter, visual profile and bridge hashes remained unchanged during the build.
The exported .27 was not overwritten. The isolated candidate is copied into this
repository, as required for a separate Avatar3DFrontend release.

## Checks and evidence

- Seven archived real sequences / 1123 frames / three repetitions: managed C#
  results bit-identical to baseline, inputs intact. 100 adversarial sequences
  also bit-identical; cancellation, invalid shape and NaN rejection preserved.
- Actual .27 vs .28 WebGL / same widget / eight identical sign sequences:
  preparation improved in every case, 19.6%–43.5%. APRENDER 2294.5→1499.5 ms;
  COMPRAR 7101.8→4079.1 ms; six-sign sequence 26512.9→15957 ms. Every execution
  reached its terminal frame. No uncaught browser exceptions. Playback itself
  was not accelerated. This is controlled local API and SwiftShader, not a
  production SLA or physical microphone/mobile certification.
- Platform integrated test with 20 distinct texts, two real players and injected
  HTTP failures is recorded in the platform report after full drain.

Reproduction/evidence in the platform workspace: `tmp/solver-latency/benchmark.ps1`,
`fuzz.ps1`, `browser-ab.cjs`, `outputs/solver-latency-parity.json`,
`outputs/solver-latency-fuzz.json`, `outputs/solver-browser-ab.json`,
`outputs/solver-latency-build-audit.json`. Solver source belongs to the separate
Unity project `C:/Users/felip/PoseAvatarTest/Assets/Scripts/ELIAPairedPoleOptimizer.cs`;
the Unity source optimization must remain with that project as well as its
compiled artifact here. The exact compiled solver source is also preserved in
`docs/unity/ELIAPairedPoleOptimizer.cs` for the separate Unity source repository;
it is not imported by the Python/widget application. No runtime profile/hand
experiment was promoted.

Full-clip preparation remains expensive for long phrases. These tests prove an
improvement for the measured cases; they do not prove zero failure forever or
complete linguistic accuracy. Validation preceded publication; push confirmation
and deployment are separate from these local test results. The platform suite
passed 78 tests; the widget passed 15 Node tests and 16 Python API/format/polling
tests. Packaged .28 smoke passed three executions to the actual last frame with
the correct runtime version (`outputs/solver-packaged-smoke.json`).
