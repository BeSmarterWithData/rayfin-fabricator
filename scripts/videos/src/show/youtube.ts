/**
 * A lesson's YouTube description: its chapters, its sources and its challenge. Pure and
 * React-free, so the packaging tool (through Node's type stripping) and the tests can use it.
 */
import type { ThumbnailSpec } from '../lesson-kit/Thumbnail';
import { beatsOf, type Chapter, type LessonScript, type Plan } from './plan.ts';

export interface YouTubeSpec {
  /** At most 100 characters. Lead with what the viewer learns. */
  title: string;
  /** The description's opening: the hook, and what the lesson covers. */
  summary: string;
  /** Ray's challenge: what to try, a prompt to paste into Fabricator's chat, and a question for the comments. */
  challenge: { task: string; prompt: string; question: string };
  thumbnail: ThumbnailSpec;
  /** The next lesson, for the end screen; null for the last one. */
  next: { number: number; title: string } | null;
  /** Tags on top of the series' own. */
  tags?: readonly string[];
}

export interface SeriesInfo {
  name: string;
  links: { fabricator: string; channel: string };
  disclaimer: string;
  hashtags: readonly string[];
}

/** YouTube's chapter rules: the first at 0:00, at least three, each at least ten seconds long. */
export const MIN_CHAPTERS = 3;
export const MIN_CHAPTER_SECONDS = 10;

/** `m:ss`, or `h:mm:ss` past an hour. */
export function timestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * The chapters as YouTube wants them: the first moved to 0:00, and any shorter than ten
 * seconds folded into the one before it. `problems` says what had to change, and is non-empty
 * when there are too few chapters to list at all.
 */
export function youtubeChapters(chapters: readonly Chapter[], fps: number, totalFrames: number): { chapters: Array<{ title: string; seconds: number }>; problems: string[] } {
  const problems: string[] = [];
  const list = chapters.map((c) => ({ title: c.title, seconds: Math.floor(c.from / fps) }));
  if (list.length && list[0].seconds !== 0) {
    problems.push(`"${list[0].title}" moved from ${timestamp(list[0].seconds)} to 0:00.`);
    list[0].seconds = 0;
  }
  const total = totalFrames / fps;
  for (let i = list.length - 1; i >= 1; i--) {
    const end = i + 1 < list.length ? list[i + 1].seconds : total;
    if (end - list[i].seconds < MIN_CHAPTER_SECONDS) {
      problems.push(`"${list[i].title}" is under ${MIN_CHAPTER_SECONDS} s, so it's folded into "${list[i - 1].title}".`);
      list.splice(i, 1);
    }
  }
  // Nothing comes before the first chapter, so it takes in the ones after it until it's long enough.
  while (list.length >= 2 && list[1].seconds < MIN_CHAPTER_SECONDS) {
    problems.push(`"${list[1].title}" starts under ${MIN_CHAPTER_SECONDS} s in, so it's folded into "${list[0].title}".`);
    list.splice(1, 1);
  }
  if (list.length < MIN_CHAPTERS) problems.push(`Only ${list.length} chapters; YouTube needs at least ${MIN_CHAPTERS}, so none are listed.`);
  return { chapters: list.length >= MIN_CHAPTERS ? list : [], problems };
}

/** Every source the lesson's lines cite, in the order they're first cited. */
export function sourcesOf(script: LessonScript): string[] {
  const seen = new Set<string>();
  for (const beat of beatsOf(script)) for (const url of beat.sources ?? []) seen.add(url);
  return [...seen];
}

/** The full description, ready to paste into YouTube Studio. */
export function describe(spec: YouTubeSpec, script: LessonScript, plan: Plan, series: SeriesInfo): { text: string; problems: string[] } {
  const { chapters, problems } = youtubeChapters(plan.chapters, plan.fps, plan.total);
  const out: string[] = [spec.summary.trim(), ''];
  if (chapters.length) {
    out.push('Chapters');
    for (const c of chapters) out.push(`${timestamp(c.seconds)} ${c.title}`);
    out.push('');
  }
  const sources = sourcesOf(script);
  if (sources.length) {
    out.push(`Learn more (checked against Rayfin ${script.rayfinVersion})`);
    for (const url of sources) out.push(`• ${url}`);
    out.push('');
  }
  out.push(`Build along with Fabricator, a free, open-source desktop app for building Rayfin apps with GitHub Copilot: ${series.links.fabricator}`);
  out.push('');
  out.push(`Ray’s challenge: ${spec.challenge.task}`);
  out.push('Try this in Fabricator’s chat:');
  out.push(`“${spec.challenge.prompt}”`);
  out.push(spec.challenge.question);
  out.push('');
  out.push(series.disclaimer);
  out.push('');
  out.push(series.hashtags.join(' '));
  return { text: out.join('\n'), problems };
}
