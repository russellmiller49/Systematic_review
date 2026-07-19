/**
 * Remove the jittery zoom/pan motion from public/guide/updated_overview.mp4.
 *
 * This product overview is composed of static UI scenes. Stabilizing it with a conventional
 * camera-warp filter would soften text and can misread chapter cuts as shake. Instead, this
 * script samples one fully visible frame from each scene, holds it for the scene's exact frame
 * count, recreates the established fades, and stream-copies the updated narration unchanged.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourcePath = join(root, "public", "guide", "updated_overview.mp4");
const outputPath = join(root, "public", "guide", "updated_overview_stabilized.mp4");
const manifestPath = join(root, "public", "guide", "updated_overview_stabilized.manifest.json");
const notesPath = join(root, "public", "guide", "updated_overview_stabilized.md");
const workDir = mkdtempSync(join(tmpdir(), "synthesis-overview-stabilize-"));
const fps = 30;
const expectedFrames = 9_360;

interface Scene {
  label: string;
  startFrame: number;
  sampleFrame: number;
  fadeIn: boolean;
  fadeOut: boolean;
}

// Frame-accurate starts measured from the user's updated 312-second export. The AI insert uses
// clean hard cuts internally; the surrounding overview chapters retain their fades to black.
const scenes: Scene[] = [
  { label: "Overview", startFrame: 0, sampleFrame: 24, fadeIn: true, fadeOut: true },
  { label: "Protocol", startFrame: 518, sampleFrame: 542, fadeIn: true, fadeOut: true },
  { label: "Import", startFrame: 1_201, sampleFrame: 1_225, fadeIn: true, fadeOut: true },
  { label: "Deduplication", startFrame: 1_767, sampleFrame: 1_791, fadeIn: true, fadeOut: true },
  { label: "Screening", startFrame: 2_259, sampleFrame: 2_283, fadeIn: true, fadeOut: true },
  { label: "Full text", startFrame: 2_998, sampleFrame: 3_022, fadeIn: true, fadeOut: true },
  { label: "Extraction", startFrame: 3_557, sampleFrame: 3_581, fadeIn: true, fadeOut: true },
  { label: "Risk of bias", startFrame: 4_211, sampleFrame: 4_235, fadeIn: true, fadeOut: true },
  { label: "Analysis", startFrame: 4_873, sampleFrame: 4_897, fadeIn: true, fadeOut: true },
  { label: "GRADE", startFrame: 5_552, sampleFrame: 5_576, fadeIn: true, fadeOut: true },
  {
    label: "AI assistance — principle",
    startFrame: 6_089,
    sampleFrame: 6_113,
    fadeIn: true,
    fadeOut: false,
  },
  {
    label: "AI assistance — screening",
    startFrame: 6_344,
    sampleFrame: 6_353,
    fadeIn: false,
    fadeOut: false,
  },
  {
    label: "AI assistance — extraction",
    startFrame: 6_640,
    sampleFrame: 6_649,
    fadeIn: false,
    fadeOut: false,
  },
  {
    label: "AI assistance — GRADE",
    startFrame: 6_955,
    sampleFrame: 6_964,
    fadeIn: false,
    fadeOut: false,
  },
  {
    label: "AI assistance — auditability",
    startFrame: 7_162,
    sampleFrame: 7_171,
    fadeIn: false,
    fadeOut: true,
  },
  {
    label: "Summary of Findings",
    startFrame: 7_524,
    sampleFrame: 7_548,
    fadeIn: true,
    fadeOut: true,
  },
  { label: "PRISMA", startFrame: 7_939, sampleFrame: 7_963, fadeIn: true, fadeOut: true },
  { label: "Audit trail", startFrame: 8_355, sampleFrame: 8_379, fadeIn: true, fadeOut: true },
  { label: "Closing", startFrame: 8_858, sampleFrame: 8_882, fadeIn: true, fadeOut: true },
];

function run(command: string, args: string[], capture = false): string {
  return execFileSync(command, args, {
    cwd: root,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  }) as unknown as string;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function probe(path: string) {
  return JSON.parse(
    run(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-show_entries",
        "format=duration,size,bit_rate:stream=index,codec_name,profile,level,pix_fmt,width,height,r_frame_rate,time_base,nb_read_frames,sample_rate,channels,channel_layout,bit_rate",
        "-of",
        "json",
        path,
      ],
      true,
    ),
  ) as Record<string, unknown>;
}

function frameTime(frame: number): string {
  return (frame / fps).toFixed(6);
}

async function main() {
  if (!existsSync(sourcePath)) throw new Error(`Missing source video: ${sourcePath}`);

  const sourceProbe = probe(sourcePath) as {
    format: { duration: string };
    streams: Array<{ codec_name: string; width?: number; height?: number; r_frame_rate?: string }>;
  };
  const video = sourceProbe.streams.find((stream) => stream.codec_name === "h264");
  if (!video || video.width !== 1_422 || video.height !== 720 || video.r_frame_rate !== "30/1") {
    throw new Error("Source video no longer matches the measured 1422×720, 30 fps export");
  }
  if (Math.abs(Number(sourceProbe.format.duration) - expectedFrames / fps) > 0.001) {
    throw new Error("Source duration changed; scene boundaries must be re-measured before export");
  }

  const rendered: string[] = [];
  const sceneManifest: Array<Record<string, string | number | boolean>> = [];

  for (const [index, scene] of scenes.entries()) {
    const endFrame = scenes[index + 1]?.startFrame ?? expectedFrames;
    const durationFrames = endFrame - scene.startFrame;
    if (durationFrames <= 0) throw new Error(`Invalid duration for ${scene.label}`);
    if (scene.sampleFrame <= scene.startFrame || scene.sampleFrame >= endFrame) {
      throw new Error(`Sample frame for ${scene.label} falls outside its scene`);
    }

    const prefix = String(index + 1).padStart(2, "0");
    const stillPath = join(workDir, `${prefix}.png`);
    const segmentPath = join(workDir, `${prefix}.mp4`);
    run("ffmpeg", [
      "-y",
      "-ss",
      frameTime(scene.sampleFrame),
      "-i",
      sourcePath,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      stillPath,
    ]);

    const filters: string[] = [];
    if (scene.fadeIn) filters.push("fade=t=in:st=0:d=0.28");
    if (scene.fadeOut) {
      filters.push(`fade=t=out:st=${Math.max(0, durationFrames / fps - 0.3).toFixed(6)}:d=0.3`);
    }
    filters.push("format=yuv420p");

    run("ffmpeg", [
      "-y",
      "-loop",
      "1",
      "-framerate",
      String(fps),
      "-i",
      stillPath,
      "-vf",
      filters.join(","),
      "-map",
      "0:v:0",
      "-frames:v",
      String(durationFrames),
      "-r",
      String(fps),
      "-fps_mode",
      "cfr",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-tune",
      "stillimage",
      "-crf",
      "16",
      "-profile:v",
      "high",
      "-level:v",
      "3.2",
      "-pix_fmt",
      "yuv420p",
      "-color_range",
      "tv",
      "-colorspace",
      "bt709",
      "-color_trc",
      "bt709",
      "-color_primaries",
      "bt709",
      "-video_track_timescale",
      "15360",
      segmentPath,
    ]);
    rendered.push(segmentPath);
    sceneManifest.push({
      label: scene.label,
      startFrame: scene.startFrame,
      endFrame,
      startSeconds: scene.startFrame / fps,
      endSeconds: endFrame / fps,
      sampleFrame: scene.sampleFrame,
      fadeIn: scene.fadeIn,
      fadeOut: scene.fadeOut,
    });
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

  // The updated narration is the authoritative audio track. Stream copy keeps every encoded AAC
  // packet unchanged while the video is replaced with stable scene holds.
  run("ffmpeg", [
    "-y",
    "-i",
    assembledPath,
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-map_metadata",
    "1",
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-t",
    (expectedFrames / fps).toFixed(6),
    "-movflags",
    "+faststart",
    outputPath,
  ]);

  const outputProbe = probe(outputPath);
  const manifest = {
    title: "Synthesis updated overview — stabilized",
    method:
      "Stable frame holds replace jittery zoom/pan motion; measured scene timing and the encoded narration are preserved.",
    source: {
      path: relative(root, sourcePath),
      bytes: statSync(sourcePath).size,
      sha256: sha256(sourcePath),
      probe: sourceProbe,
    },
    output: {
      path: relative(root, outputPath),
      bytes: statSync(outputPath).size,
      sha256: sha256(outputPath),
      probe: outputProbe,
    },
    expectedFrames,
    fps,
    audio: "AAC stream copied from the source without re-encoding",
    scenes: sceneManifest,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    notesPath,
    `# Stabilized Synthesis overview\n\n- Source preserved: \`public/guide/updated_overview.mp4\`\n- Output: \`public/guide/updated_overview_stabilized.mp4\`\n- Method: replaced the jittery per-scene zoom/pan with stable frame holds.\n- Timing: 9,360 frames at 30 fps (312.000 seconds).\n- Audio: the updated stereo AAC narration is stream-copied without re-encoding.\n- Transitions: main chapters retain short fades; internal AI scenes retain clean hard cuts.\n- Provenance and checksums: \`public/guide/updated_overview_stabilized.manifest.json\`.\n\nRebuild with \`npm run stabilize:guide-overview\`. The source file is never overwritten.\n`,
  );

  console.log(
    `Built stabilized overview · ${(expectedFrames / fps).toFixed(3)}s · ${(statSync(outputPath).size / 1_048_576).toFixed(1)} MiB`,
  );
  console.log(`Output: ${outputPath}`);
  console.log(`Temporary render files: ${workDir}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
