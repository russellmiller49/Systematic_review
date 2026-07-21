# Stabilized Synthesis overview

- Source preserved: `public/guide/updated_overview.mp4`
- Output: `public/guide/updated_overview_stabilized.mp4`
- Method: replaced the jittery per-scene zoom/pan with stable frame holds.
- Timing: 9,360 frames at 30 fps (312.000 seconds).
- Audio: the updated stereo AAC narration is stream-copied without re-encoding.
- Transitions: main chapters retain short fades; internal AI scenes retain clean hard cuts.
- Provenance and checksums: `public/guide/updated_overview_stabilized.manifest.json`.
- Used by `/guide` with a matching poster, English captions, chapter navigation, download
  link, and on-page transcript.

Rebuild with `npm run stabilize:guide-overview`. The source file is never overwritten.
