// Puts the end screen's elements on the slots the lesson draws: the next lesson (or the playlist) over NEXT UP, and Subscribe over the round slot.
//
//   npm run yt -- endscreen --lesson <n>                                in the upload dialog
//   npm run yt -- endscreen --lesson <n> --video-id <id> --replace      on a published video
//
// Options:
//   --next <video id>  the video for NEXT UP. By default, the next lesson's video when
//                      lessons/channel.ts has it, and otherwise the series' playlist.
//   --replace          delete the elements already there first (without it, the step stops).
//   --no-save          leave the editor open, unsaved, to look at. To drop it, click Discard
//                      changes and reload the page: the editor remembers discarded elements
//                      until you do.
//
// Both elements start at upload.json's endScreen.start (the first whole second of the slots) and
// end with the video. The editor's preview is the frame at about a quarter scale, so the step
// works out each element's place from END_SLOTS and drags it there, then checks where it landed.
import { FRAME, STUDIO, drag, endScreenTargets, lessonOf, loadChannel, loadUpload, oembed, stringArg, styleBox, uploadsDialog } from '../studio.mjs';

/** How far, in preview pixels (about 4 frame pixels each), an element may land from its slot. */
const TOLERANCE = 3;

export default async ({ page, log, shot, args }) => {
  const CHANNEL = await loadChannel();
  const n = lessonOf(args);
  const up = await loadUpload(n);
  const videoId = stringArg(args, 'video-id');
  const nextId = stringArg(args, 'next') ?? (up.next ? CHANNEL.lessons[up.next.number] : undefined) ?? null;

  if (videoId) {
    await page.goto(`${STUDIO}/video/${videoId}/edit`, { waitUntil: 'load' });
    await page.waitForTimeout(5000);
    await page.locator('#endscreen-editor-link').click();
  } else {
    const dialog = uploadsDialog(page);
    if (!(await dialog.isVisible())) throw new Error('No upload dialog is open. For a published video, pass --video-id <id>.');
    await dialog.locator('#step-badge-1').click();
    await page.waitForTimeout(1500);
    await dialog.locator('#endscreens-button').click();
  }
  const editor = page.locator('ytve-modal-host');
  const panel = page.locator('ytve-endscreen-editor-options-panel');
  await panel.waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);
  // Only live elements count: the editor keeps deleted ones in the page (rows faded to opacity 0,
  // preview items without their `visible` class) until it's reloaded.
  const items = page.locator('ytve-endscreen-editor-preview-overlay-item.visible').filter({ has: page.locator('.ytp-ce-element') });
  const selected = page.locator('ytve-endscreen-editor-preview-overlay-item.visible.selected').first();
  const overlay = () => page.locator('ytve-endscreen-editor-preview-overlay').boundingBox();
  const rows = () =>
    page.locator('ytve-endscreen-row').evaluateAll((els) =>
      els
        .filter((e) => {
          const cs = getComputedStyle(e);
          return cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && e.getBoundingClientRect().width > 0;
        })
        .map((e) => e.innerText.trim()),
    );

  // What's there already. A click on an element in the preview selects it (its row in the
  // timeline is covered by a time handle), and #delete in the options panel removes it.
  const existing = await rows();
  if (existing.length) {
    if (!args.replace) throw new Error(`The end screen already has: ${existing.join('; ')}. Pass --replace to start over.`);
    for (let i = 0; i < existing.length; i++) {
      await items.first().click();
      await page.waitForTimeout(600);
      await panel.locator('#delete').click();
      await page.waitForTimeout(1000);
    }
    const left = await rows();
    if (left.length) throw new Error(`Couldn’t clear the end screen: ${left.join('; ')} still there.`);
    log('cleared:', existing);
  }

  const add = async (kind) => {
    await page.locator('#add-element-menu-button').click();
    await page.waitForTimeout(800);
    await page
      .locator('[role=menuitem], tp-yt-paper-item')
      .filter({ hasText: new RegExp(`^\\s*${kind}\\s*$`) })
      .last()
      .click();
    await page.waitForTimeout(2500);
  };
  const startAt = async () => {
    const inputs = panel.locator('input:not([type=checkbox])');
    await inputs.nth(0).click({ clickCount: 3 });
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(up.endScreen.start, { delay: 60 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const [from, to] = await inputs.evaluateAll((els) => els.map((e) => e.value));
    if (from !== up.endScreen.start) throw new Error(`The element starts at ${from}, not ${up.endScreen.start}.`);
    return `${from}–${to}`;
  };

  // NEXT UP: the next lesson's video, or the playlist until it's up.
  let nextUp;
  if (nextId) {
    const info = await oembed(nextId);
    if (!info) throw new Error(`Video ${nextId} isn't public yet, so it can't go on the end screen.`);
    await add('Video');
    await panel.locator('tp-yt-paper-radio-button').filter({ hasText: 'Choose specific video' }).click();
    const picker = page.locator('ytcp-dialog#inner-dialog');
    await picker.locator('ytcp-entity-card').first().waitFor({ timeout: 20000 });
    let card = picker.locator('ytcp-entity-card').filter({ hasText: info.title }).first();
    if (!(await card.count())) {
      await picker.getByPlaceholder('Search your videos').fill(info.title);
      await page.waitForTimeout(2500);
      card = picker.locator('ytcp-entity-card').filter({ hasText: info.title }).first();
    }
    await card.click();
    await page.waitForTimeout(2500);
    nextUp = `Video: ${info.title}`;
  } else {
    await add('Playlist');
    await page.getByText(CHANNEL.playlist.title, { exact: true }).last().click();
    await page.waitForTimeout(3000);
    nextUp = `Playlist: ${CHANNEL.playlist.title}`;
  }
  let ov = await overlay();
  let t = endScreenTargets(up.endScreen.slots, ov.width / FRAME.width);
  let b = styleBox(await selected.getAttribute('style'));
  let grab = { x: ov.x + b.left + b.width / 2, y: ov.y + b.top + b.height / 2 };
  await drag(page, grab, { x: grab.x + t.video.left - b.left, y: grab.y + t.video.top - b.top });
  await page.waitForTimeout(800);
  // Then size it from its bottom-right handle; it keeps 16:9 and its top-left corner.
  b = styleBox(await selected.getAttribute('style'));
  const handle = await selected.locator('div.drag.bottom-right').boundingBox();
  grab = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  await drag(page, grab, { x: grab.x + t.video.width - b.width, y: grab.y + t.video.height - b.height });
  await page.waitForTimeout(800);
  b = styleBox(await selected.getAttribute('style'));
  const offVideo = Math.max(Math.abs(b.left - t.video.left), Math.abs(b.top - t.video.top), Math.abs(b.width - t.video.width));
  if (!(offVideo <= TOLERANCE)) throw new Error(`NEXT UP landed ${offVideo.toFixed(1)} px from its slot: ${JSON.stringify(b)} vs ${JSON.stringify(t.video)}.`);
  const nextTimes = await startAt();
  log(`${nextUp}: ${nextTimes}, within ${offVideo.toFixed(1)} px of the slot`);

  // Subscribe: a fixed-size circle, centered on the round slot. The preview moves when the
  // options panel changes, so measure it again.
  await add('Subscribe');
  ov = await overlay();
  t = endScreenTargets(up.endScreen.slots, ov.width / FRAME.width);
  b = styleBox(await selected.getAttribute('style'));
  grab = { x: ov.x + b.left + b.width / 2, y: ov.y + b.top + b.height / 2 };
  await drag(page, grab, { x: ov.x + t.subscribe.cx, y: ov.y + t.subscribe.cy });
  await page.waitForTimeout(800);
  b = styleBox(await selected.getAttribute('style'));
  const offSub = Math.hypot(b.left + b.width / 2 - t.subscribe.cx, b.top + b.height / 2 - t.subscribe.cy);
  if (!(offSub <= TOLERANCE)) throw new Error(`Subscribe landed ${offSub.toFixed(1)} px from its slot.`);
  const subTimes = await startAt();
  log(`Subscribe: ${subTimes}, within ${offSub.toFixed(1)} px of the slot`);

  const warning = /[^\n]*(cannot overlap|too close together)[^\n]*/.exec(await editor.innerText())?.[0];
  if (warning) throw new Error(`YouTube says: ${warning.trim()}`);
  if (args['no-save']) {
    await shot('endscreen');
    log('Left the editor open, unsaved.');
    return { nextUp, saved: false };
  }
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await panel.waitFor({ state: 'hidden', timeout: 30000 });
  await page.waitForTimeout(1500);
  log('saved');
  await shot('endscreen');
  return { nextUp, start: up.endScreen.start, saved: true };
};
