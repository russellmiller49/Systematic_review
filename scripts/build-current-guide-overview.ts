/**
 * Extend the stabilized narrated overview with the product features added after it was recorded.
 *
 * The first fourteen chapters are retained from updated_overview_stabilized.mp4. Its outdated
 * closing is replaced with fresh, deterministic chapters built from the seeded product captures
 * listed in currentFeatureVideoChapters. macOS `say`, ffmpeg, ffprobe, and sharp are required.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import sharp from "sharp";
import { currentFeatureVideoChapters } from "../src/content/user-guide";

const root = resolve(import.meta.dirname, "..");
const guideDir = join(root, "public", "guide");
const captureDir = join(guideDir, "captures");
const sourcePath = join(guideDir, "updated_overview_stabilized.mp4");
const sourceCaptionsPath = join(guideDir, "updated_overview_stabilized.en.vtt");
const sourceChaptersPath = join(guideDir, "updated_overview_stabilized.chapters.vtt");
const outputPath = join(guideDir, "synthesis-current-overview.mp4");
const captionsPath = join(guideDir, "synthesis-current-overview.en.vtt");
const chaptersPath = join(guideDir, "synthesis-current-overview.chapters.vtt");
const posterPath = join(guideDir, "synthesis-current-overview-poster.jpg");
const manifestPath = join(guideDir, "synthesis-current-overview.manifest.json");
const notesPath = join(guideDir, "synthesis-current-overview.md");
const workDir = mkdtempSync(join(tmpdir(), "synthesis-current-overview-"));

const fps = 30;
const width = 1_422;
const height = 720;
const baseCutFrame = 8_858;
const baseCutSeconds = baseCutFrame / fps;
const tailPadding = 0.58;
const voice = "Samantha";
const speechRate = "178";

interface BuiltChapter {
  start: number;
  duration: number;
  frames: number;
  voiceDuration: number;
  path: string;
}

function run(command: string, args: string[], capture = false): string {
  return execFileSync(command, args, {
    cwd: root,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  }) as unknown as string;
}

function ffmpeg(args: string[]): void {
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-stats", ...args]);
}

function probe(path: string): Record<string, unknown> {
  return JSON.parse(
    run(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        path,
      ],
      true,
    ),
  ) as Record<string, unknown>;
}

function probeDuration(path: string): number {
  return Number(
    run(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
      true,
    ).trim(),
  );
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
  const millis = Math.max(0, Math.round(seconds * 1_000));
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  const secs = Math.floor((millis % 60_000) / 1_000);
  const ms = millis % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function parseTimestamp(value: string): number {
  const match = value.match(/^(\d+):(\d+):(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid WebVTT timestamp: ${value}`);
  return (
    Number(match[1]) * 3_600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(`0.${match[4]}`)
  );
}

function preservedCueBlocks(path: string, endSeconds: number): string[] {
  const blocks = readFileSync(path, "utf8").trim().split(/\n{2,}/);
  return blocks.filter((block) => {
    const timing = block.match(
      /(\d+:\d+:\d+\.\d+)\s+-->\s+(\d+:\d+:\d+\.\d+)/,
    );
    return timing ? parseTimestamp(timing[2]!) <= endSeconds + 0.002 : false;
  });
}

function sentences(value: string): string[] {
  return value.match(/[^.!?]+[.!?]+(?:[”"])?/g)?.map((part) => part.trim()) ?? [value];
}

async function buildChapter(
  index: number,
  cursor: number,
): Promise<BuiltChapter> {
  const chapter = currentFeatureVideoChapters[index]!;
  const prefix = String(index + 1).padStart(2, "0");
  const audioPath = join(workDir, `${prefix}.aiff`);
  const overlayPath = join(workDir, `${prefix}-overlay.png`);
  const segmentPath = join(workDir, `${prefix}.mp4`);
  const imagePath = join(captureDir, chapter.image);

  const overlay = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="562" width="${width}" height="158" fill="#0b1020" fill-opacity="0.97" />
      <text x="56" y="600" fill="#a5b4fc" font-family="Helvetica Neue, Arial, sans-serif" font-size="15" font-weight="600" letter-spacing="2.4">${escapeXml(chapter.label.toUpperCase())}</text>
      <text x="56" y="646" fill="#ffffff" font-family="Helvetica Neue, Arial, sans-serif" font-size="32" font-weight="600">${escapeXml(chapter.title)}</text>
      <text x="57" y="683" fill="#cbd5e1" font-family="Helvetica Neue, Arial, sans-serif" font-size="17">${escapeXml(chapter.subtitle)}</text>
      <text x="${width - 56}" y="600" text-anchor="end" fill="#94a3b8" font-family="Helvetica Neue, Arial, sans-serif" font-size="13" font-weight="600" letter-spacing="3">SYNTHESIS</text>
    </svg>`;
  await sharp(Buffer.from(overlay)).png().toFile(overlayPath);

  run("/usr/bin/say", [
    "-v",
    voice,
    "-r",
    speechRate,
    "-o",
    audioPath,
    chapter.narration,
  ]);
  const voiceDuration = probeDuration(audioPath);
  const frames = Math.ceil((voiceDuration + tailPadding) * fps);
  const duration = frames / fps;
  const fadeOutStart = Math.max(0, duration - 0.3).toFixed(3);

  const filter = [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=#f8fafc,eq=brightness=-0.018:saturation=0.94[base]`,
    `[base][1:v]overlay=0:0:format=auto:shortest=1,fade=t=in:st=0:d=0.28,fade=t=out:st=${fadeOutStart}:d=0.3,format=yuv420p[v]`,
    `[2:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=-2.6dB,apad=pad_dur=${tailPadding},afade=t=in:st=0:d=0.16,afade=t=out:st=${fadeOutStart}:d=0.3[a]`,
  ].join(";");

  ffmpeg([
    "-y",
    "-loop",
    "1",
    "-framerate",
    String(fps),
    "-i",
    imagePath,
    "-loop",
    "1",
    "-framerate",
    String(fps),
    "-i",
    overlayPath,
    "-i",
    audioPath,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-frames:v",
    String(frames),
    "-t",
    duration.toFixed(6),
    "-r",
    String(fps),
    "-fps_mode",
    "cfr",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-tune",
    "stillimage",
    "-crf",
    "18",
    "-profile:v",
    "high",
    "-level:v",
    "3.2",
    "-pix_fmt",
    "yuv420p",
    "-colorspace",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_primaries",
    "bt709",
    "-video_track_timescale",
    "15360",
    "-c:a",
    "aac",
    "-b:a",
    "224k",
    "-ar",
    "48000",
    "-ac",
    "2",
    segmentPath,
  ]);

  return { start: cursor, duration, frames, voiceDuration, path: segmentPath };
}

async function main(): Promise<void> {
  const sourceProbe = probe(sourcePath) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const sourceVideo = sourceProbe.streams?.find((stream) => stream.codec_type === "video");
  if (
    sourceVideo?.width !== width ||
    sourceVideo?.height !== height ||
    sourceVideo?.r_frame_rate !== "30/1"
  ) {
    throw new Error("The stabilized source no longer matches the measured 1422×720, 30 fps export");
  }

  const baseSegmentPath = join(workDir, "00-retained-overview.mp4");
  ffmpeg([
    "-y",
    "-i",
    sourcePath,
    "-vf",
    `trim=end_frame=${baseCutFrame},setpts=PTS-STARTPTS,format=yuv420p`,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-frames:v",
    String(baseCutFrame),
    "-t",
    baseCutSeconds.toFixed(6),
    "-r",
    String(fps),
    "-fps_mode",
    "cfr",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-tune",
    "stillimage",
    "-crf",
    "18",
    "-profile:v",
    "high",
    "-level:v",
    "3.2",
    "-pix_fmt",
    "yuv420p",
    "-colorspace",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_primaries",
    "bt709",
    "-video_track_timescale",
    "15360",
    "-c:a",
    "copy",
    baseSegmentPath,
  ]);

  const built: BuiltChapter[] = [];
  let cursor = baseCutSeconds;
  for (const index of currentFeatureVideoChapters.keys()) {
    const chapter = await buildChapter(index, cursor);
    built.push(chapter);
    cursor += chapter.duration;
  }

  const concatPath = join(workDir, "concat.txt");
  const segments = [baseSegmentPath, ...built.map((chapter) => chapter.path)];
  writeFileSync(
    concatPath,
    `${segments.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n")}\n`,
  );
  ffmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputPath,
  ]);

  const baseCaptionBlocks = preservedCueBlocks(sourceCaptionsPath, baseCutSeconds);
  const captionBlocks = [...baseCaptionBlocks];
  const baseChapterBlocks = preservedCueBlocks(sourceChaptersPath, baseCutSeconds);
  const chapterBlocks = [...baseChapterBlocks];

  for (const [index, chapter] of currentFeatureVideoChapters.entries()) {
    const timing = built[index]!;
    const chapterNumber = baseChapterBlocks.length + index + 1;
    const parts = sentences(chapter.narration);
    const weights = parts.map((part) => part.split(/\s+/).length);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const captionWindow = Math.max(0.2, timing.voiceDuration - 0.14);
    let localCursor = timing.start + 0.08;

    for (const [sentenceIndex, part] of parts.entries()) {
      const sentenceDuration = captionWindow * (weights[sentenceIndex]! / totalWeight);
      const sentenceEnd = Math.min(
        timing.start + timing.voiceDuration,
        localCursor + sentenceDuration,
      );
      captionBlocks.push(
        [
          `${chapterNumber}.${sentenceIndex + 1}`,
          `${timestamp(localCursor)} --> ${timestamp(sentenceEnd)}`,
          part,
        ].join("\n"),
      );
      localCursor = sentenceEnd;
    }

    chapterBlocks.push(
      [
        String(chapterNumber),
        `${timestamp(timing.start)} --> ${timestamp(timing.start + timing.duration)}`,
        `${chapter.label}: ${chapter.title}`,
      ].join("\n"),
    );
  }

  writeFileSync(
    captionsPath,
    `WEBVTT\n\nNOTE English narration for the current Synthesis product overview\n\n${captionBlocks.join("\n\n")}\n`,
  );
  writeFileSync(
    chaptersPath,
    `WEBVTT\n\nNOTE Chapter navigation for the current Synthesis product overview\n\n${chapterBlocks.join("\n\n")}\n`,
  );

  ffmpeg([
    "-y",
    "-ss",
    "1.2",
    "-i",
    outputPath,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    "-update",
    "1",
    posterPath,
  ]);

  // Decode every frame before publishing the artifact.
  ffmpeg(["-v", "error", "-i", outputPath, "-f", "null", "-"]);

  const expectedFrames = baseCutFrame + built.reduce((sum, chapter) => sum + chapter.frames, 0);
  const outputProbe = probe(outputPath) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const outputVideo = outputProbe.streams?.find((stream) => stream.codec_type === "video");
  const decodedFrames = Number(outputVideo?.nb_read_frames);
  if (decodedFrames !== expectedFrames) {
    throw new Error(`Expected ${expectedFrames} frames, decoded ${decodedFrames}`);
  }

  const captures = currentFeatureVideoChapters.map((chapter) => {
    const path = join(captureDir, chapter.image);
    return {
      path: relative(root, path),
      bytes: statSync(path).size,
      sha256: sha256(path),
    };
  });
  const manifest = {
    title: "Synthesis current product overview",
    method:
      "Retains the first fourteen chapters of the stabilized overview, replaces its outdated closing, and appends deterministic seeded-product captures with fresh narration.",
    source: {
      path: relative(root, sourcePath),
      bytes: statSync(sourcePath).size,
      sha256: sha256(sourcePath),
      retainedThroughFrame: baseCutFrame,
      retainedThroughSeconds: baseCutSeconds,
      retainedChapters: baseChapterBlocks.length,
      probe: sourceProbe,
    },
    output: {
      path: relative(root, outputPath),
      bytes: statSync(outputPath).size,
      sha256: sha256(outputPath),
      expectedFrames,
      decodedFrames,
      duration: probeDuration(outputPath),
      probe: outputProbe,
    },
    video: { width, height, fps },
    narration: {
      retained: "Natural narration from the stabilized source for chapters 1–14",
      new: `macOS say voice ${voice} at ${speechRate} words per minute, gain-matched at -2.6 dB`,
    },
    chapters: currentFeatureVideoChapters.map((chapter, index) => ({
      label: chapter.label,
      title: chapter.title,
      startSeconds: built[index]!.start,
      endSeconds: built[index]!.start + built[index]!.duration,
      frames: built[index]!.frames,
      voiceDuration: built[index]!.voiceDuration,
      image: relative(root, join(captureDir, chapter.image)),
    })),
    captures,
    tracks: {
      captions: relative(root, captionsPath),
      chapters: relative(root, chaptersPath),
      poster: relative(root, posterPath),
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    notesPath,
    `# Current Synthesis product overview\n\n- Source preserved: \`${relative(root, sourcePath)}\`.\n- The first fourteen chapters remain; the former closing at frame ${baseCutFrame} is replaced.\n- New coverage: chat and assignments, notifications, library/open-access retrieval, references, manuscript drafting, guideline PICO sub-reviews, compiled guideline export, and an updated closing.\n- Output: \`${relative(root, outputPath)}\` (${(probeDuration(outputPath) / 60).toFixed(2)} minutes, ${expectedFrames.toLocaleString()} frames at ${fps} fps).\n- English captions, chapter navigation, poster, source hashes, and capture hashes are included beside the MP4.\n- Rebuild with \`npm run build:current-guide-video\`. The stabilized source is never overwritten.\n`,
  );

  console.log(
    `Built current overview · ${(probeDuration(outputPath) / 60).toFixed(2)} min · ${(statSync(outputPath).size / 1_048_576).toFixed(1)} MiB`,
  );
  console.log(`Output: ${outputPath}`);
  console.log(`Temporary render files: ${workDir}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
