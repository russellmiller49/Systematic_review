# Synthesis AI feature insert

This directory contains a 44-second, 1920×1080 visual insert for the Synthesis overview. The MP4 has a silent AAC-LC mono track at 48 kHz so a natural narration can be recorded and mixed directly.

## Editorial placement

- Insert at `02:59.334`, after the GRADE section and before Summary of Findings.
- Record the narration in `docs/synthesis-ai-insert-transcript.txt`.
- Use `synthesis-ai-insert.en.vtt` for captions and `synthesis-ai-insert.chapters.vtt` for navigation.
- Fade into the insert at the existing chapter transition, then fade directly into Summary of Findings.

## Rebuild

1. Prepare and capture the isolated seeded demo documented by `scripts/prepare-guide-ai-capture.ts`.
2. Run `npm run build:guide-ai-insert`.
3. Confirm the video against `manifest.json` and visually review the poster/contact frames.

The screenshots are preserved under `captures/`; the render script never alters them.
