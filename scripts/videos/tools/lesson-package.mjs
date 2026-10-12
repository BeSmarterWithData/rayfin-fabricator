// Packages a rendered lesson for YouTube.
//
//   npm run lesson:package -- 1
//
// Writes out/lessons/<slug>/youtube/:
//   <slug>.mp4         the video, as rendered and mastered by lesson:render
//   <slug>.en.vtt      English captions, timed from the voice
//   thumbnail.jpg      1280×720, under 2 MB
//   youtube.md         what to paste into YouTube Studio, and the upload checklist
// and keeps a copy of youtube.md in the lesson's folder, as the record of what was published.
//
// It refuses a lesson that isn't fully voiced, a render older than the files the video shows or
// says, and a render whose length no longer matches the lesson's timing (the captions and
// chapters come from that timing).
import { createRequire } from 'node:module';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderStill, selectComposition } from '@remotion/renderer';
import { webpackOverride } from '../webpack-override.mjs';
import { durationSeconds, run } from './audio.mjs';
import { mergeOrphans, toVtt, videoCues } from './captions.mjs';
import { lessonArg, loadLesson } from './lesson.mjs';
import { REPO, ROOT } from './paths.mjs';
import { SERIES } from '../lessons/series.ts';
import { isVoiced, planLesson } from '../src/show/plan.ts';
import { describe, timestamp } from '../src/show/youtube.ts';

const sharp = createRequire(path.join(REPO, 'website', 'package.json'))('sharp');
const MAX_THUMBNAIL = 2 * 1024 * 1024;
/** YouTube's end screens run for 5–20 seconds at the end of a video. */
const END_SCREEN_MAX = 20;

/** The number of frames in a video's picture, as its container records them. */
async function videoFrames(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', file]);
  return Number(stdout.toString().trim());
}

async function main() {
  const n = lessonArg();
  const lesson = await loadLesson(n);
  const { script, youtube, timeline } = lesson;
  if (!isVoiced(script, timeline)) throw new Error(`Lesson ${n} isn't fully voiced (npm run lesson:voice -- ${n}).`);
  if (!existsSync(lesson.video)) throw new Error(`Render it first: npm run lesson:render -- ${n}.`);
  const rendered = (await stat(lesson.video)).mtimeMs;
  // What the video shows and says, and what its captions and description are made from.
  const sources = [...['script.ts', 'scenes.tsx', 'snippets.ts', 'youtube.ts', 'timeline.json'].map((file) => path.join(lesson.dir, file)), path.join(ROOT, 'lessons', 'series.ts')];
  for (const full of sources) {
    if (existsSync(full) && (await stat(full)).mtimeMs > rendered) {
      throw new Error(`${path.relative(ROOT, full).replace(/\\/g, '/')} changed after the render. Render again (npm run lesson:render -- ${n}).`);
    }
  }

  const plan = planLesson(script, timeline);
  const frames = await videoFrames(lesson.video);
  if (frames !== plan.total) {
    throw new Error(`The render has ${frames} frames, but lesson ${n} now has ${plan.total}: its timing changed after the render. Render again (npm run lesson:render -- ${n}).`);
  }
  const dest = path.join(lesson.out, 'youtube');
  await mkdir(dest, { recursive: true });
  const problems = [];

  // The video.
  const video = path.join(dest, `${lesson.slug}.mp4`);
  await copyFile(lesson.video, video);
  const seconds = await durationSeconds(video);
  const megabytes = (await stat(video)).size / 1024 / 1024;

  // Captions, from where each line sits in the lesson.
  const starts = Object.fromEntries(plan.order.filter((id) => plan.beats[id].line).map((id) => [id, (plan.beats[id].from / plan.fps) * 1000]));
  const vtt = path.join(dest, `${lesson.slug}.en.vtt`);
  await writeFile(vtt, toVtt(mergeOrphans(videoCues(timeline.lines, starts))));

  // The thumbnail: drawn at 1920×1080, delivered at 1280×720.
  await ensureBrowser();
  const serveUrl = await bundle({ entryPoint: path.join(ROOT, 'src', 'index.ts'), webpackOverride: webpackOverride(ROOT) });
  const inputProps = { lesson: n, theme: 'dark' };
  const still = await selectComposition({ serveUrl, id: lesson.thumbnail, inputProps });
  const png = path.join(lesson.out, 'thumbnail.png');
  await renderStill({ serveUrl, composition: still, frame: 0, output: png, imageFormat: 'png', inputProps });
  const thumbnail = path.join(dest, 'thumbnail.jpg');
  let quality = 92;
  for (;;) {
    await sharp(png).resize(1280, 720).jpeg({ quality, mozjpeg: true }).toFile(thumbnail);
    if ((await stat(thumbnail)).size <= MAX_THUMBNAIL || quality <= 60) break;
    quality -= 8;
  }

  // The words.
  const { text: description, problems: chapterProblems } = describe(youtube, script, plan, SERIES);
  problems.push(...chapterProblems);
  if (youtube.title.length > 100) problems.push(`The title is ${youtube.title.length} characters; YouTube allows 100.`);
  if (description.length > 5000) problems.push(`The description is ${description.length} characters; YouTube allows 5,000.`);
  const tags = [...new Set([...SERIES.tags, ...(youtube.tags ?? [])])];
  if (tags.join(',').length > 500) problems.push('The tags run over YouTube’s 500 characters.');
  const endFrom = Math.max(seconds - END_SCREEN_MAX, (plan.scenes.next?.from ?? plan.total) / plan.fps);
  const pinned = `Ray’s challenge: ${youtube.challenge.task}\nTry this in Fabricator’s chat:\n“${youtube.challenge.prompt}”\n${youtube.challenge.question}`;
  const rel = (f) => path.relative(REPO, f).replace(/\\/g, '/');

  const md = `# ${youtube.title}

Generated by \`npm run lesson:package -- ${n}\` from lessons/${lesson.slug}/script.ts and youtube.ts. Don't edit it by hand.

## Upload

- **Video:** \`${rel(video)}\` (${timestamp(seconds)}, ${megabytes.toFixed(1)} MB)
- **Thumbnail:** \`${rel(thumbnail)}\`
- **Captions:** \`${rel(vtt)}\`, language English
- **Playlist:** ${SERIES.name}, as lesson ${n}
- **Audience:** No, it's not made for kids. (Videos made for kids lose comments and end screens, and this one asks for both.)
- **Category:** Education. **Language:** English.
- **Checked against:** Rayfin ${script.rayfinVersion}

## Title

${youtube.title}

## Description

\`\`\`text
${description}
\`\`\`

## Tags

${tags.join(', ')}

## Pinned comment

\`\`\`text
${pinned}
\`\`\`

## End screen

From ${timestamp(endFrom)} to the end (${Math.round(seconds - endFrom)} s):

- A **video** element over the "${youtube.next ? 'NEXT UP' : 'WATCH NEXT'}" slot on the left: ${youtube.next ? `lesson ${youtube.next.number}, "${youtube.next.title}", once it's up; until then, the playlist` : 'the playlist'}.
- A **subscribe** element over the round slot on the right.
${problems.length ? `\n## Check before uploading\n\n${problems.map((p) => `- ${p}`).join('\n')}\n` : ''}`;
  await writeFile(path.join(dest, 'youtube.md'), md);
  await writeFile(path.join(lesson.dir, 'youtube.md'), md);

  for (const f of [video, vtt, thumbnail, path.join(dest, 'youtube.md')]) console.log(rel(f));
  console.log(rel(path.join(lesson.dir, 'youtube.md')));
  if (problems.length) console.warn(`\n${problems.map((p) => `! ${p}`).join('\n')}`);
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
