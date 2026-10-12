import assert from 'node:assert/strict';
import test from 'node:test';
import { describe, sourcesOf, timestamp, youtubeChapters } from '../src/show/youtube.ts';

const FPS = 30;

test('timestamps read like YouTube’s', () => {
  assert.equal(timestamp(0), '0:00');
  assert.equal(timestamp(9.9), '0:09');
  assert.equal(timestamp(75), '1:15');
  assert.equal(timestamp(3725), '1:02:05');
});

test('the first chapter starts at 0:00, and short chapters fold into the one before', () => {
  const { chapters, problems } = youtubeChapters(
    [
      { title: 'Hook', from: 9 },
      { title: 'Short', from: 30 * 20 },
      { title: 'Middle', from: 30 * 25 },
      { title: 'End', from: 30 * 60 },
    ],
    FPS,
    30 * 90,
  );
  assert.deepEqual(chapters, [
    { title: 'Hook', seconds: 0 },
    { title: 'Middle', seconds: 25 },
    { title: 'End', seconds: 60 },
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"Short" is under 10 s/);
});

test('a first chapter under ten seconds takes in the ones after it, rather than voiding them all', () => {
  const { chapters, problems } = youtubeChapters(
    [
      { title: 'Hook', from: 0 },
      { title: 'Welcome', from: 30 * 6 },
      { title: 'Middle', from: 30 * 40 },
      { title: 'End', from: 30 * 80 },
    ],
    FPS,
    30 * 120,
  );
  assert.deepEqual(chapters, [
    { title: 'Hook', seconds: 0 },
    { title: 'Middle', seconds: 40 },
    { title: 'End', seconds: 80 },
  ]);
  assert.deepEqual(problems, ['"Welcome" starts under 10 s in, so it\'s folded into "Hook".']);
  // Every chapter YouTube gets is at least ten seconds long.
  const ends = [...chapters.slice(1).map((c) => c.seconds), 120];
  chapters.forEach((c, i) => assert.ok(ends[i] - c.seconds >= 10, `${c.title} is ${ends[i] - c.seconds} s`));
});

test('fewer than three chapters are not listed', () => {
  const { chapters, problems } = youtubeChapters(
    [
      { title: 'A', from: 0 },
      { title: 'B', from: 30 * 30 },
    ],
    FPS,
    30 * 60,
  );
  assert.deepEqual(chapters, []);
  assert.match(problems.at(-1), /Only 2 chapters/);
});

test('the description has the summary, chapters, each source once, the challenge and the disclaimer', () => {
  const script = {
    number: 1,
    slug: '01-x',
    title: 'X',
    rayfinVersion: '1.2.3',
    scenes: [
      { id: 's', beats: [{ id: 'a', text: 'One.', sources: ['https://rayfin.ai/docs', 'https://rayfin.ai/docs/data'] }, { id: 'b', text: 'Two.', sources: ['https://rayfin.ai/docs'] }] },
    ],
  };
  assert.deepEqual(sourcesOf(script), ['https://rayfin.ai/docs', 'https://rayfin.ai/docs/data']);
  const plan = {
    fps: FPS,
    total: 30 * 100,
    chapters: [
      { title: 'Start', from: 0 },
      { title: 'Middle', from: 30 * 40 },
      { title: 'End', from: 30 * 80 },
    ],
  };
  const spec = { title: 'T', summary: 'The summary.', challenge: { task: 'Do the thing.', prompt: 'Build it.', question: 'What did you build?' }, thumbnail: { kicker: '', lines: [] }, next: null };
  const series = { name: 'S', links: { fabricator: 'https://f', channel: 'https://c' }, disclaimer: 'Not official.', hashtags: ['#A', '#B'] };
  const { text, problems } = describe(spec, script, plan, series);
  assert.deepEqual(problems, []);
  assert.ok(text.startsWith('The summary.\n'));
  assert.match(text, /Chapters\n0:00 Start\n0:40 Middle\n1:20 End\n/);
  assert.match(text, /Learn more \(checked against Rayfin 1\.2\.3\)\n• https:\/\/rayfin\.ai\/docs\n• https:\/\/rayfin\.ai\/docs\/data\n/);
  assert.match(text, /Ray’s challenge: Do the thing\.\nTry this in Fabricator’s chat:\n“Build it\.”\nWhat did you build\?/);
  assert.ok(text.endsWith('Not official.\n\n#A #B'));
});
