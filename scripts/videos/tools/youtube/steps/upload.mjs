// Starts an upload: opens Studio's upload dialog on the channel and gives it the lesson's video. The dialog then stays open for the next steps.
//
//   npm run yt -- upload --lesson <n>
//
// YouTube saves the upload as a private draft at once. Next: details, subtitles, endscreen,
// visibility, then publish.
import { STUDIO, filesOf, lessonOf, loadChannel, loadUpload, studioChannel, uploadsDialog } from '../studio.mjs';

export default async ({ page, log, shot, args }) => {
  const CHANNEL = await loadChannel();
  const up = await loadUpload(lessonOf(args));
  const files = filesOf(up);
  const dialog = uploadsDialog(page).locator('tp-yt-paper-dialog').first(); // its panel: see uploadsDialog
  if (await dialog.isVisible()) throw new Error('An upload dialog is already open. Finish it, or close it in Studio, first.');
  await page.goto(`${STUDIO}/channel/${CHANNEL.id}/videos/upload`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const { channelId } = await studioChannel(page);
  if (channelId !== CHANNEL.id) throw new Error(`Studio is on channel ${channelId ?? '(none)'}, not ${CHANNEL.name}. Is the browser signed in to the right account? Run the status step.`);
  let input = page.locator('input[type=file]');
  if (!(await input.count())) {
    await page.getByRole('button', { name: /^Create$/ }).first().click();
    await page.getByText('Upload videos', { exact: true }).click();
    await page.waitForTimeout(2000);
    input = page.locator('input[type=file]');
  }
  await input.first().setInputFiles(files.video);
  await dialog.getByRole('textbox').first().waitFor({ timeout: 60000 });
  const link = await dialog
    .locator('a[href*="youtu.be/"]')
    .first()
    .getAttribute('href', { timeout: 60000 })
    .catch(() => null);
  log('uploading:', files.video);
  log('video:', link ?? '(no link yet)');
  await shot('upload');
  return { link, id: link ? link.split('/').pop() : null };
};
