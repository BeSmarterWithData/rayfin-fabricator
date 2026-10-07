// Saving images the user pastes into the Help prompt.
//
// A screenshot is often the quickest way to show what went wrong, so the
// composer accepts one straight from the clipboard. The image is re-encoded to
// PNG (shrinking anything oversized) and written to the app's temp captures
// folder, reusing the same path the chat composer's attachments take. The
// resulting path is attached to the question, which makes it readable for that
// turn and nothing more.
import { readAsDataUrl, toPngAndThumb } from '../chat/images'

/** Re-encode a pasted image and save it, returning the file path to attach. */
export async function savePastedImage(file: File): Promise<string> {
  const source = await readAsDataUrl(file)
  const { png } = await toPngAndThumb(source)
  return window.api.screenshot.save(png)
}
