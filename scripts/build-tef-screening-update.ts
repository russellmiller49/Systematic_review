/**
 * Build a review cut of the TEF PICO 1 tutorial from the user's source MP4.
 *
 * Usage:
 *   npx tsx scripts/build-tef-screening-update.ts SOURCE_MP4 PICO_PNG POOL_PNG OUTPUT_DIR
 *
 * The new UI screens must contain synthetic or otherwise approved demonstration data.
 * This script never overwrites the source and does not publish the result.
 * Requires ffmpeg/ffprobe and macOS `say` for a replaceable scratch narration track.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import sharp from "sharp";

const [sourceArg, picoArg, poolArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !picoArg || !poolArg || !outputArg) {
  console.error(
    "Usage: npx tsx scripts/build-tef-screening-update.ts SOURCE_MP4 PICO_PNG POOL_PNG OUTPUT_DIR",
  );
  process.exit(1);
}

const source = resolve(sourceArg);
const picoScreenshot = resolve(picoArg);
const poolScreenshot = resolve(poolArg);
const outputDir = resolve(outputArg);
const workDir = mkdtempSync(join(tmpdir(), "tef-screening-update-"));
const sourceCutAtSeconds = 382.8;
const fps = 30;

type Scene = {
  title: string;
  subline: string;
  narration: string;
  image?: string;
  cropTop?: number;
  points?: string[];
};

const scenes: Scene[] = [
  {
    title: "Synthesis screening has changed",
    subline: "Updated workflow · synthetic demonstration data",
    narration:
      "The PICO one criteria we just reviewed still belong to PICO one. The software workflow has changed. In the current Synthesis guideline workspace, first choose the screening queue. PICO one remains an individual queue. A named combined pool contains only the other PICO questions that the guideline team selected. Before every session, make sure you are using the criteria for the queue in front of you.",
    points: [
      "PICO 1: individual abstract queue",
      "Combined pool: selected other PICOs",
      "Use the approved criteria for the selected queue",
    ],
  },
  {
    title: "Screen PICO 1 in its own queue",
    subline: "Search and choose an available abstract",
    narration:
      "For PICO one, read the title and abstract against the approved PICO one protocol. The article list is searchable, and you can choose a record without screening strictly in order. Your target shows completed and remaining reviews. If a necessary detail is unclear in the abstract, record that uncertainty. Do not assume an unmentioned test was absent.",
    image: picoScreenshot,
    cropTop: 0,
  },
  {
    title: "Record the reason or uncertainty",
    subline: "Include · Exclude with a reason · Maybe with a note",
    narration:
      "Use Include when the record appears eligible under the protocol. Use Maybe when the title and abstract cannot settle eligibility, and add a note about what needs checking. Exclude when the record clearly fails a criterion, selecting one of the configured reasons. The decision and note are saved together. Keyboard shortcuts are shown on the controls for reviewers who prefer them.",
    image: picoScreenshot,
    cropTop: 420,
  },
  {
    title: "Choose the combined pool",
    subline: "One logical abstract can appear in several PICOs",
    narration:
      "Back at guideline Abstract screening, select the saved combined pool. This demonstration groups PICO two through four, while PICO one remains separate. The actual pool name and membership are set by an owner or admin in guideline settings. The Found in badges on an abstract identify its linked PICOs. One pooled decision and note apply to those linked records. The PICO one rules from earlier in this video do not automatically apply here.",
    image: poolScreenshot,
    cropTop: 0,
  },
  {
    title: "Your target is a count, not a reservation",
    subline: "Browse · search · skip without using a review",
    narration:
      "Your target shows how many logical abstracts you have reviewed and how many reviews remain. Available lists abstracts that still need your review. You may select any listed article, search, move to another page, or skip with Next. Browsing and skipping do not reserve an abstract and do not use part of your target. If the pool is empty before your target is met, ask an admin to review the corpus or target.",
    image: poolScreenshot,
    cropTop: 260,
  },
  {
    title: "One pooled decision, one quota credit",
    subline: "Linked PICO records update together",
    narration:
      "When you save Include, Exclude with a compatible reason, or Maybe, Synthesis writes the decision and note to every linked PICO copy. It counts once toward your reviewer target. The review count shows how many independent reviews have been submitted. When blinding is enabled, you can see your own choice and the aggregate count, but not another reviewer's unresolved choice. Pooled decisions are made one logical abstract at a time.",
    image: poolScreenshot,
    cropTop: 568,
  },
  {
    title: "Review history and resolution",
    subline: "My reviewed · conflicts · pool health",
    narration:
      "My reviewed lets you return to your saved decisions and notes. An unfinalized decision can be revised; a final outcome is locked until the project follows its reopening process. After the required independent reviews, Synthesis records a final result or handles disagreement through the configured conflict process. Owners and admins manage targets and pool health. Records marked Needs synchronization require an administrator to reconcile their linked copies before another pooled decision.",
    points: [
      "My reviewed keeps your saved work accessible",
      "Final outcomes lock the decision",
      "Owners and admins monitor pool health",
    ],
  },
  {
    title: "Before you screen",
    subline: "Choose queue → Check criteria → Decide and note → Review progress",
    narration:
      "Before each screening session, confirm the queue and its criteria. Choose an available abstract, record the decision and reason or note, then check your remaining target. PICO one and the combined pool are separate workflows.",
    points: [
      "Choose the correct queue",
      "Use its approved criteria",
      "Save a reason or note",
      "Check your remaining target",
    ],
  },
];

function run(command: string, args: string[], capture = false): string {
  return execFileSync(command, args, {
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  }) as unknown as string;
}

function duration(path: string): number {
  return Number(
    run(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
      true,
    ).trim(),
  );
}

function timestamp(seconds: number): string {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function sceneImage(scene: Scene, imagePath: string) {
  const background = sharp({
    create: { width: 1920, height: 1080, channels: 4, background: "#0b1020" },
  });
  const composites: sharp.OverlayOptions[] = [];
  if (scene.image) {
    const metadata = await sharp(scene.image).metadata();
    const cropHeight = Math.min(720, metadata.height ?? 720);
    const cropTop = Math.min(
      scene.cropTop ?? 0,
      (metadata.height ?? 720) - cropHeight,
    );
    const screenshot = await sharp(scene.image)
      .extract({ left: 0, top: cropTop, width: 1280, height: cropHeight })
      .resize(1600, 900, { fit: "fill" })
      .png()
      .toBuffer();
    composites.push({ input: screenshot, left: 160, top: 112 });
  }
  const panel = scene.points
    ? `<rect x="160" y="230" width="1600" height="625" rx="28" fill="#111a34" stroke="#4657a4" stroke-width="2" />
       ${scene.points
         .map(
           (point, index) =>
             `<circle cx="230" cy="${325 + index * 125}" r="17" fill="#6366f1" />
              <text x="280" y="${337 + index * 125}" fill="white" font-family="Arial, sans-serif" font-size="38">${xml(point)}</text>`,
         )
         .join("")}`
    : "";
  const overlay = Buffer.from(`
    <svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
      ${panel}
      <rect x="0" y="0" width="1920" height="104" fill="#0b1020" />
      <text x="160" y="68" fill="#ffffff" font-family="Arial, sans-serif" font-size="45" font-weight="700">${xml(scene.title)}</text>
      <text x="1760" y="62" text-anchor="end" fill="#a5b4fc" font-family="Arial, sans-serif" font-size="20" font-weight="700" letter-spacing="2">SYNTHETIC DEMO</text>
      <rect x="0" y="1010" width="1920" height="70" fill="#0b1020" />
      <text x="160" y="1054" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="27">${xml(scene.subline)}</text>
      <text x="1760" y="1054" text-anchor="end" fill="#94a3b8" font-family="Arial, sans-serif" font-size="20">REVIEW CUT</text>
    </svg>`);
  composites.push({ input: overlay, left: 0, top: 0 });
  await background.composite(composites).png().toFile(imagePath);
}

function writeCaptions(
  cues: string[],
  narration: string,
  start: number,
  voiceDuration: number,
  sceneIndex: number,
) {
  const parts =
    narration.match(/[^.!?]+[.!?]+/g)?.map((part) => part.trim()) ?? [narration];
  const total = parts.reduce((sum, part) => sum + part.split(/\s+/).length, 0);
  let cursor = start + 0.06;
  for (const [index, part] of parts.entries()) {
    const end = Math.min(
      start + voiceDuration,
      cursor + (voiceDuration - 0.12) * (part.split(/\s+/).length / total),
    );
    cues.push(
      `${sceneIndex + 1}.${index + 1}`,
      `${timestamp(cursor)} --> ${timestamp(end)}`,
      part,
      "",
    );
    cursor = end;
  }
}

async function main() {
  mkdirSync(outputDir, { recursive: true });
  const sourceClip = join(workDir, "00-source.mp4");
  run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", source,
    "-t", String(sourceCutAtSeconds),
    "-vf", `fps=${fps}`,
    "-af", `afade=t=out:st=${sourceCutAtSeconds - 0.45}:d=0.45`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
    "-pix_fmt", "yuv420p", "-r", String(fps),
    "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
    sourceClip,
  ]);

  const built = [sourceClip];
  const captions = [
    "WEBVTT", "", "NOTE Draft captions for the newly recorded workflow segment only.",
    "NOTE The preserved source narration needs a reviewed caption track before publication.", "",
  ];
  const chapters = [
    "WEBVTT", "", "1", `00:00:00.000 --> ${timestamp(duration(sourceClip))}`,
    "PICO 1 question and screening criteria (source)", "",
  ];
  let cursor = duration(sourceClip);
  const sceneTimes: { title: string; start: number; duration: number }[] = [];

  for (const [index, scene] of scenes.entries()) {
    const number = String(index + 1).padStart(2, "0");
    const imagePath = join(workDir, `${number}.png`);
    const audioPath = join(workDir, `${number}.aiff`);
    const videoPath = join(workDir, `${number}.mp4`);
    await sceneImage(scene, imagePath);
    run("/usr/bin/say", [
      "-v", "Samantha", "-r", "168", "-o", audioPath, scene.narration,
    ]);
    const voiceDuration = duration(audioPath);
    const sceneDuration = voiceDuration + 0.7;
    run("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-i", imagePath,
      "-i", audioPath, "-t", sceneDuration.toFixed(3),
      "-vf", `fps=${fps},fade=t=in:st=0:d=0.2,fade=t=out:st=${(sceneDuration - 0.25).toFixed(3)}:d=0.25`,
      "-af", `volume=-3dB,apad=pad_dur=0.7,afade=t=in:st=0:d=0.16,afade=t=out:st=${(sceneDuration - 0.3).toFixed(3)}:d=0.3`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
      "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
      videoPath,
    ]);
    const actualDuration = duration(videoPath);
    writeCaptions(captions, scene.narration, cursor, voiceDuration, index);
    chapters.push(
      String(index + 2),
      `${timestamp(cursor)} --> ${timestamp(cursor + actualDuration)}`,
      scene.title,
      "",
    );
    sceneTimes.push({ title: scene.title, start: cursor, duration: actualDuration });
    cursor += actualDuration;
    built.push(videoPath);
  }

  const listPath = join(workDir, "concat.txt");
  writeFileSync(
    listPath,
    built.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n") + "\n",
  );
  const outputPath = join(outputDir, "TEF-PICO-1-screening-updated-review-cut.mp4");
  run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
    "-i", listPath, "-c", "copy", "-movflags", "+faststart", outputPath,
  ]);
  const captionPath = join(outputDir, "TEF-PICO-1-screening-updated-draft.en.vtt");
  const chapterPath = join(outputDir, "TEF-PICO-1-screening-updated-draft.chapters.vtt");
  const voiceoverPath = join(outputDir, "TEF-PICO-1-screening-updated-draft-voiceover.md");
  writeFileSync(captionPath, captions.join("\n"));
  writeFileSync(chapterPath, chapters.join("\n"));
  writeFileSync(
    voiceoverPath,
    "# Updated Synthesis workflow — scratch voiceover\n\n" +
      "The original clinician narration is preserved through 06:22.8. " +
      "The text below is the replaceable narration for the new section.\n\n" +
      scenes
        .map(
          (scene, index) =>
            `## ${timestamp(sceneTimes[index]!.start)} — ${scene.title}\n\n${scene.narration}\n`,
        )
        .join("\n") +
      "\n",
  );
  const posterPath = join(outputDir, "TEF-PICO-1-screening-updated-draft-poster.jpg");
  run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-ss", timestamp(duration(sourceClip) + 2),
    "-i", outputPath, "-frames:v", "1", "-update", "1", posterPath,
  ]);
  const manifestPath = join(outputDir, "TEF-PICO-1-screening-updated-draft.manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        status: "review cut; synthetic UI data; scratch narration",
        source: {
          filename: basename(source),
          sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
          cutAtSeconds: sourceCutAtSeconds,
        },
        output: { filename: basename(outputPath), durationSeconds: duration(outputPath) },
        captions: basename(captionPath),
        chapters: basename(chapterPath),
        voiceover: basename(voiceoverPath),
        poster: basename(posterPath),
        scenes: sceneTimes,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Review cut: ${outputPath}`);
  console.log(`Duration: ${duration(outputPath).toFixed(2)} seconds`);
  console.log(`Scratch render files: ${workDir}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
