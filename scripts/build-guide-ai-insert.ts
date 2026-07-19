/**
 * Build the silent, splice-ready AI feature insert for the Synthesis overview.
 *
 * The visuals are real screenshots from an isolated seeded workspace. The MP4 deliberately
 * contains a silent AAC track matching the overview video's channel layout and sample rate, so
 * a natural voiceover can be recorded and mixed without first conforming the file.
 *
 * Requirements: ffmpeg, ffprobe, and the repository's installed Node dependencies.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "..");
const outputDir = join(root, "public", "guide", "ai-insert");
const captureDir = join(outputDir, "captures");
const overviewCaptureDir = join(root, "public", "guide", "captures");
const workDir = mkdtempSync(join(tmpdir(), "synthesis-ai-insert-"));
const outputPath = join(outputDir, "synthesis-ai-insert-silent.mp4");
const fps = 30;
const durationSeconds = 44;

interface Segment {
  label: string;
  title: string;
  subtitle: string;
  source: string;
  duration: number;
}

const segments: Segment[] = [
  {
    label: "AI assistance",
    title: "A second set of eyes",
    subtitle: "Optional assistance · Human decisions remain authoritative",
    source: join(overviewCaptureDir, "01-dashboard.jpg"),
    duration: 7,
  },
  {
    label: "Title & abstract screening",
    title: "Prioritize, never decide",
    subtitle: "Likelihood scores, rationale, and a separate reviewer choice",
    source: join(captureDir, "02-ai-screening.jpg"),
    duration: 9,
  },
  {
    label: "Data extraction",
    title: "Evidence-linked extraction",
    subtitle: "Suggested values with quoted evidence and page references",
    source: join(captureDir, "03-ai-extraction.jpg"),
    duration: 5.5,
  },
  {
    label: "Risk of bias",
    title: "Draft judgments with quotes",
    subtitle: "Domain rationale, confidence, and supporting evidence",
    source: join(captureDir, "04-ai-rob.jpg"),
    duration: 5.5,
  },
  {
    label: "GRADE",
    title: "Context-aware rationale",
    subtitle: "Per-domain prose grounded in pooled results and protocol context",
    source: join(captureDir, "05-ai-grade.jpg"),
    duration: 7,
  },
  {
    label: "Human control & traceability",
    title: "People decide. Accepted work is traceable.",
    subtitle: "Suggestions stay separate · Reviewers choose what to apply",
    source: join(captureDir, "06-ai-audit.jpg"),
    duration: 10,
  },
];

function run(command: string, args: string[], capture = false): string {
  return execFileSync(command, args, {
    cwd: root,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  }) as unknown as string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function timestamp(seconds: number): string {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function probe(path: string): {
  duration: number;
  streams: Array<Record<string, string | number>>;
} {
  const result = JSON.parse(
    run(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=index,codec_name,profile,level,pix_fmt,width,height,r_frame_rate,sample_rate,channels,channel_layout",
        "-of",
        "json",
        path,
      ],
      true,
    ),
  ) as {
    format: { duration: string };
    streams: Array<Record<string, string | number>>;
  };
  return { duration: Number(result.format.duration), streams: result.streams };
}

async function renderOverlay(segment: Segment, index: number): Promise<string> {
  const path = join(workDir, `${String(index + 1).padStart(2, "0")}-overlay.png`);
  const overlay = `
    <svg width="1920" height="1080" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">
      <rect x="141" y="11" width="1638" height="922" rx="10" fill="none" stroke="#ffffff" stroke-opacity="0.34" stroke-width="3" />
      <rect x="0" y="932" width="1920" height="148" fill="#0b1020" fill-opacity="0.97" />
      <rect x="80" y="953" width="38" height="4" rx="2" fill="#818cf8" />
      <text x="132" y="968" fill="#a5b4fc" font-family="Helvetica Neue, Arial, sans-serif" font-size="17" font-weight="650" letter-spacing="2.5">${escapeXml(segment.label.toUpperCase())}</text>
      <text x="80" y="1015" fill="#ffffff" font-family="Helvetica Neue, Arial, sans-serif" font-size="35" font-weight="650">${escapeXml(segment.title)}</text>
      <text x="82" y="1053" fill="#cbd5e1" font-family="Helvetica Neue, Arial, sans-serif" font-size="20">${escapeXml(segment.subtitle)}</text>
      <text x="1840" y="968" text-anchor="end" fill="#94a3b8" font-family="Helvetica Neue, Arial, sans-serif" font-size="17" font-weight="650" letter-spacing="3.5">SYNTHESIS · AI</text>
    </svg>`;
  await sharp(Buffer.from(overlay)).png().toFile(path);
  return path;
}

async function main() {
  mkdirSync(outputDir, { recursive: true });

  const total = segments.reduce((sum, segment) => sum + segment.duration, 0);
  if (total !== durationSeconds) {
    throw new Error(`Segment durations total ${total}s; expected ${durationSeconds}s`);
  }

  const rendered: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const overlayPath = await renderOverlay(segment, index);
    const segmentPath = join(workDir, `${String(index + 1).padStart(2, "0")}.mp4`);
    const frameCount = Math.round(segment.duration * fps);
    const fadeIn = index === 0 ? ",fade=t=in:st=0:d=0.28" : "";
    const fadeOut =
      index === segments.length - 1
        ? `,fade=t=out:st=${(segment.duration - 0.3).toFixed(3)}:d=0.3`
        : "";
    const filter = [
      `[0:v]split=2[background-source][screen-source]`,
      `[background-source]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=28,eq=brightness=-0.18:saturation=0.62[background]`,
      `[screen-source]scale=1632:918,zoompan=z='min(zoom+0.00008,1.025)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frameCount}:s=1632x918:fps=${fps}[screen]`,
      `[background][screen]overlay=144:14:format=auto[framed]`,
      `[framed][1:v]overlay=0:0:format=auto${fadeIn}${fadeOut},format=yuvj420p[video]`,
    ].join(";");

    run("ffmpeg", [
      "-y",
      "-loop",
      "1",
      "-framerate",
      String(fps),
      "-i",
      segment.source,
      "-loop",
      "1",
      "-framerate",
      String(fps),
      "-i",
      overlayPath,
      "-filter_complex",
      filter,
      "-map",
      "[video]",
      "-an",
      "-t",
      segment.duration.toFixed(3),
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-level:v",
      "4.0",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuvj420p",
      "-color_range",
      "pc",
      "-colorspace",
      "bt470bg",
      "-video_track_timescale",
      "15360",
      segmentPath,
    ]);
    rendered.push(segmentPath);
  }

  const concatPath = join(workDir, "concat.txt");
  writeFileSync(
    concatPath,
    `${rendered.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n")}\n`,
  );
  const assembledPath = join(workDir, "assembled.mp4");
  run("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatPath,
    "-c",
    "copy",
    assembledPath,
  ]);

  run("ffmpeg", [
    "-y",
    "-i",
    assembledPath,
    "-f",
    "lavfi",
    "-t",
    String(durationSeconds),
    "-i",
    "anullsrc=channel_layout=mono:sample_rate=48000",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-ac",
    "1",
    "-t",
    String(durationSeconds),
    "-movflags",
    "+faststart",
    outputPath,
  ]);

  writeFileSync(
    join(outputDir, "synthesis-ai-insert.en.vtt"),
    [
      "WEBVTT",
      "",
      "NOTE Natural-voice transcript cues for the Synthesis AI feature insert",
      "",
      "1",
      "00:00:00.080 --> 00:00:07.000",
      "AI assistance in Synthesis is optional, and it is designed as a second set of eyes—not an automated decision-maker.",
      "",
      "2",
      "00:00:07.000 --> 00:00:16.000",
      "During title-and-abstract screening, it can score and prioritize citations, then show reviewers a suggested decision and rationale.",
      "",
      "3",
      "00:00:16.000 --> 00:00:27.000",
      "For extraction and risk of bias, it can read the linked PDF, propose values or domain judgments, and surface supporting quotes with page references.",
      "",
      "4",
      "00:00:27.000 --> 00:00:34.000",
      "In GRADE, it can draft per-domain rationale from the current pooled results and protocol context.",
      "",
      "5",
      "00:00:34.000 --> 00:00:43.800",
      "Suggestions stay separate from the authoritative record. A reviewer chooses what to apply, existing work is protected, and accepted changes follow the normal audit trail.",
      "",
    ].join("\n"),
  );

  const chapterCues = [
    [0, 7, "AI assistance: A second set of eyes"],
    [7, 16, "AI screening: Prioritize, never decide"],
    [16, 27, "Extraction and risk of bias: Evidence-linked drafts"],
    [27, 34, "GRADE: Context-aware rationale"],
    [34, 44, "Safeguards: Human control and traceability"],
  ] as const;
  writeFileSync(
    join(outputDir, "synthesis-ai-insert.chapters.vtt"),
    [
      "WEBVTT",
      "",
      "NOTE Chapter navigation for the Synthesis AI feature insert",
      "",
      ...chapterCues.flatMap(([start, end, title], index) => [
        String(index + 1),
        `${timestamp(start)} --> ${timestamp(end)}`,
        title,
        "",
      ]),
    ].join("\n"),
  );

  run("ffmpeg", [
    "-y",
    "-ss",
    "10.5",
    "-i",
    outputPath,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    "-update",
    "1",
    join(outputDir, "synthesis-ai-insert-poster.jpg"),
  ]);

  const inspection = probe(outputPath);
  const sources = segments.map((segment) => ({
    path: relative(root, segment.source),
    sha256: sha256(segment.source),
    durationSeconds: segment.duration,
  }));
  const manifest = {
    title: "Synthesis AI feature insert",
    purpose: "Silent visual insert for a separately recorded natural voiceover",
    intendedInsertAt: "00:02:59.334",
    durationSeconds,
    frameRate: fps,
    resolution: { width: 1920, height: 1080 },
    video: { codec: "H.264", profile: "High", pixelFormat: "yuvj420p" },
    audio: { codec: "AAC-LC", sampleRate: 48000, channels: 1, content: "silence" },
    transcript: "docs/synthesis-ai-insert-transcript.txt",
    detailedScript: "docs/synthesis-ai-insert-script.md",
    output: {
      path: relative(root, outputPath),
      bytes: statSync(outputPath).size,
      sha256: sha256(outputPath),
      probedDurationSeconds: Number(inspection.duration),
      streams: inspection.streams,
    },
    sources,
  };
  writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  writeFileSync(
    join(outputDir, "README.md"),
    `# Synthesis AI feature insert\n\nThis directory contains a 44-second, 1920×1080 visual insert for the Synthesis overview. The MP4 has a silent AAC-LC mono track at 48 kHz so a natural narration can be recorded and mixed directly.\n\n## Editorial placement\n\n- Insert at \`02:59.334\`, after the GRADE section and before Summary of Findings.\n- Record the narration in \`docs/synthesis-ai-insert-transcript.txt\`.\n- Use \`synthesis-ai-insert.en.vtt\` for captions and \`synthesis-ai-insert.chapters.vtt\` for navigation.\n- Fade into the insert at the existing chapter transition, then fade directly into Summary of Findings.\n\n## Rebuild\n\n1. Prepare and capture the isolated seeded demo documented by \`scripts/prepare-guide-ai-capture.ts\`.\n2. Run \`npm run build:guide-ai-insert\`.\n3. Confirm the video against \`manifest.json\` and visually review the poster/contact frames.\n\nThe screenshots are preserved under \`captures/\`; the render script never alters them.\n`,
  );

  console.log(
    `Built ${segments.length} scenes · ${Number(inspection.duration).toFixed(3)}s · ${(statSync(outputPath).size / 1_048_576).toFixed(1)} MiB`,
  );
  console.log(`Output: ${outputPath}`);
  console.log(`Temporary render files: ${workDir}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
