/**
 * Build the narrated, captioned product overview embedded at /guide.
 *
 * The source screens live in public/guide/captures and were recorded from the seeded demo
 * workspace. macOS `say`, ffmpeg, and ffprobe are required. The generated MP4, poster, and
 * WebVTT tracks are checked in so deployments do not need any of those tools.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { videoChapters } from "../src/content/user-guide";

const root = resolve(import.meta.dirname, "..");
const captureDir = join(root, "public", "guide", "captures");
const outputDir = join(root, "public", "guide");
const workDir = mkdtempSync(join(tmpdir(), "synthesis-guide-video-"));
const fps = 30;
const tailPadding = 0.55;

function run(command: string, args: string[], capture = false): string {
  return execFileSync(command, args, {
    cwd: root,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  }) as unknown as string;
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

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function timestamp(seconds: number): string {
  const millis = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  const secs = Math.floor((millis % 60_000) / 1000);
  const ms = millis % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function sentences(value: string): string[] {
  return value.match(/[^.!?]+[.!?]+(?:[”"])?/g)?.map((part) => part.trim()) ?? [value];
}

interface BuiltChapter {
  start: number;
  duration: number;
  voiceDuration: number;
  path: string;
}

async function main() {
const built: BuiltChapter[] = [];
let cursor = 0;

for (const [index, chapter] of videoChapters.entries()) {
  const prefix = String(index + 1).padStart(2, "0");
  const audioPath = join(workDir, `${prefix}.aiff`);
  const videoPath = join(workDir, `${prefix}.mp4`);
  const overlayPath = join(workDir, `${prefix}-overlay.png`);
  const imagePath = join(captureDir, chapter.image);

  const overlay = `
    <svg width="1920" height="1080" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="848" width="1920" height="232" fill="#0b1020" fill-opacity="0.96" />
      <text x="80" y="905" fill="#a5b4fc" font-family="Helvetica Neue, Arial, sans-serif" font-size="21" font-weight="600" letter-spacing="3">${escapeXml(chapter.label.toUpperCase())}</text>
      <text x="80" y="970" fill="#ffffff" font-family="Helvetica Neue, Arial, sans-serif" font-size="48" font-weight="600">${escapeXml(chapter.title)}</text>
      <text x="82" y="1025" fill="#cbd5e1" font-family="Helvetica Neue, Arial, sans-serif" font-size="24">${escapeXml(chapter.subtitle)}</text>
      <text x="1840" y="905" text-anchor="end" fill="#94a3b8" font-family="Helvetica Neue, Arial, sans-serif" font-size="18" font-weight="600" letter-spacing="4">SYNTHESIS</text>
    </svg>`;
  await sharp(Buffer.from(overlay)).png().toFile(overlayPath);

  run("/usr/bin/say", ["-v", "Samantha", "-r", "178", "-o", audioPath, chapter.narration]);
  const voiceDuration = probeDuration(audioPath);
  const duration = voiceDuration + tailPadding;
  const frames = Math.ceil(duration * fps);
  const fadeOutStart = Math.max(0, duration - 0.3).toFixed(3);

  const filter = [
    `[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,zoompan=z='min(zoom+0.00018,1.035)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1920x1080:fps=${fps},eq=brightness=-0.025:saturation=0.93[base]`,
    `[base][1:v]overlay=0:0:format=auto:shortest=1,fade=t=in:st=0:d=0.28,fade=t=out:st=${fadeOutStart}:d=0.3,format=yuv420p[v]`,
    `[2:a]apad=pad_dur=${tailPadding},afade=t=in:st=0:d=0.18,afade=t=out:st=${Math.max(0, duration - 0.3).toFixed(3)}:d=0.3[a]`,
  ].join(";");

  run("ffmpeg", [
    "-y",
    "-loop", "1",
    "-i", imagePath,
    "-loop", "1",
    "-i", overlayPath,
    "-i", audioPath,
    "-filter_complex", filter,
    "-map", "[v]",
    "-map", "[a]",
    "-t", duration.toFixed(3),
    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-c:a", "aac",
    "-b:a", "160k",
    "-ar", "48000",
    videoPath,
  ]);

  built.push({ start: cursor, duration, voiceDuration, path: videoPath });
  cursor += duration;
}

const concatPath = join(workDir, "concat.txt");
writeFileSync(
  concatPath,
  built.map((chapter) => `file '${chapter.path.replaceAll("'", "'\\''")}'`).join("\n") + "\n",
);

const assembledPath = join(workDir, "assembled.mp4");
run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", assembledPath]);
run("ffmpeg", [
  "-y",
  "-i", assembledPath,
  "-c", "copy",
  "-movflags", "+faststart",
  join(outputDir, "synthesis-overview.mp4"),
]);

const captions: string[] = ["WEBVTT", "", "NOTE Narration for the Synthesis product overview", ""];
const chapters: string[] = ["WEBVTT", "", "NOTE Chapter navigation for the Synthesis product overview", ""];

for (const [index, chapter] of videoChapters.entries()) {
  const timing = built[index]!;
  const parts = sentences(chapter.narration);
  const weights = parts.map((part) => part.split(/\s+/).length);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let localCursor = timing.start + 0.08;
  const captionWindow = Math.max(0.2, timing.voiceDuration - 0.12);

  for (const [sentenceIndex, part] of parts.entries()) {
    const sentenceDuration = captionWindow * (weights[sentenceIndex]! / totalWeight);
    const sentenceEnd = Math.min(timing.start + timing.voiceDuration, localCursor + sentenceDuration);
    captions.push(
      `${index + 1}.${sentenceIndex + 1}`,
      `${timestamp(localCursor)} --> ${timestamp(sentenceEnd)}`,
      part,
      "",
    );
    localCursor = sentenceEnd;
  }

  chapters.push(
    String(index + 1),
    `${timestamp(timing.start)} --> ${timestamp(timing.start + timing.duration)}`,
    `${chapter.label}: ${chapter.title}`,
    "",
  );
}

writeFileSync(join(outputDir, "synthesis-overview.en.vtt"), captions.join("\n"));
writeFileSync(join(outputDir, "synthesis-overview.chapters.vtt"), chapters.join("\n"));

run("ffmpeg", [
  "-y",
  "-ss", "1.2",
  "-i", join(outputDir, "synthesis-overview.mp4"),
  "-frames:v", "1",
  "-q:v", "3",
  "-update", "1",
  join(outputDir, "overview-poster.jpg"),
]);

const finalDuration = probeDuration(join(outputDir, "synthesis-overview.mp4"));
const finalBytes = readFileSync(join(outputDir, "synthesis-overview.mp4")).byteLength;
console.log(
  `Built ${videoChapters.length} chapters · ${finalDuration.toFixed(1)}s · ${(finalBytes / 1_048_576).toFixed(1)} MiB`,
);
console.log(`Temporary render files: ${workDir}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
