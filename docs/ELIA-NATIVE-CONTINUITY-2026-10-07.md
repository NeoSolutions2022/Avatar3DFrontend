# ELIA native playback and presentation continuity

The ELIA WebGL bundle and manifest in this changeset come from the isolated
Unity 6000.2.2f1 continuity-v5 build of ELIARuntime, not a widget-only update.
The serialized approved scene, source poses and hand refinement defaults were
not changed for this build. Other experimental hand candidates are not enabled.

Native runtime reports preparing/started/progress/finished with playbackId,
revision and source frame. Finished is emitted only after rendering the source
terminal frame. Widget filters stale generations and advertises the capability
only after the actual runtime ready packet. Legacy runtime remains supported.

Presentation continuity repeats a captured completed clip during PPC preparation
of the next source. It does not advance the new source clock or emit completion.
The component follows the driver of the visible skin; enabled alone is not
sufficient because the variant switcher can animate hidden and visible copies.
Explicit pause wins, mesh/rig replacement invalidates the cache, oversized
recordings are rejected rather than played partially. Cache is instance-local.

Validation: eight Unity lifecycle assertions, six widget tests, two actual
WebGL widgets through 46/46/76/228/228-frame sequences and cached replay.
Each output produced one terminal-frame completion per execution. Continuity
was observed during preparation; two captured postures were visually inspected.
Not full anatomical/linguistic QA, native PiP initialization or mobile validation.
Integrated pitch evidence is recorded separately in the platform repository.

Reproducible build provenance (SHA256):

- EliaVisualContinuity.cs: E1326AC1BAC75BBBAEA3011869E3FFAD9562741EE1B5709D5174B6285466434E
- PoseSkeletonVisualizer.cs: F421D34BF6A17FA6E6E7377BAF6BC9E8472DECE79D0A3C4586F622D30670C63D
- Avatar3DBridge.jslib: 4EA3A9C93056C8CF5450FC55623520592C657C8D205912AC66036C785059442E
- ELIARuntime.unity: BF674B0D47CEE9B269D05681793254F90EC31AD45188B39E4AD57BA660C7AD40

Workspace evidence: outputs/native-playback-build-continuity-v5-audit.json and
outputs/pose-isolation-1791348200629/report.json. Large runtime assets use Git LFS.
Preparation may remain slow; this does not certify one-hour live lectures or
promise recovery from process termination, lost GPU contexts or device limits.
