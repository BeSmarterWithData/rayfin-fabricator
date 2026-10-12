# Uploading and updating lessons on YouTube

The YouTube tools in `scripts/videos/tools/youtube/` drive YouTube Studio in a real browser that
the user signs in to. They were built while publishing lesson 1 (October 2026). Each step checks
its own work and saves screenshots to `scripts/videos/out/youtube/shots/`; look at them. Studio
changes its pages without notice, so when a step stops working, fix the step rather than working
around it.

What goes on YouTube (title, description, thumbnail, captions, the end screen's layout) is in
[youtube.md](youtube.md). This file is how to get it there, and how to change it later.

## The channel

`scripts/videos/lessons/channel.ts` holds what the tools need to know:

| | |
| --- | --- |
| Channel | Fabricator, `@RayfinFabricator`, `UCbkqoj2jPG5n81qFgBJjpCA` |
| Playlist | "Learn Rayfin with Ray", `PLXW2FECmSE6Q`: public, sorted by date published (oldest first), with the Fabricator intro (`4T1oQmT8Bks`) first |
| `lessons` | Each published lesson's video id, by number |
| `aiUse` | The channel owner's answer to Studio's "AI use" question: `no` |

The channel has YouTube's advanced features (October 2026), so links in descriptions are
clickable and comments can be pinned.

## Rules

- **The user signs in.** Never type a password, a code or a phone number, and never read the
  browser profile's cookies. When Studio asks for a sign-in or a verification, ask the user to do
  it in the browser window, and wait.
- **Ask before anything viewers see.** Publishing (subscribers are notified), changing a video's
  visibility, deleting anything, and changing a published video's title, description, thumbnail
  or captions all need the user's yes through ask_user, with a summary of what changes. Pointing
  the previous lesson's end screen at a new one is part of publishing that lesson.
- **AI use** is `CHANNEL.aiUse`. YouTube wants a "yes" for AI that makes a real person appear to
  say or do something, alters footage of a real event or place, makes a realistic scene that
  didn't happen, or makes music that's the main focus. The lessons are animated, Ray is a
  cartoon and the music is a bed under his voice, so the owner chose "no". If a lesson changes
  any of that, ask them again.
- **Comments go out as the channel.** The comment step checks that YouTube will post as
  "Fabricator" first.
- **Nothing from the browser goes in the repo.** The browser profile and the driver's token live
  in `%LOCALAPPDATA%\fabricator-videos\youtube\` (`~/.cache/fabricator-videos/youtube/` elsewhere,
  or `YT_STATE`). Screenshots go to `out/`, which git ignores.
- **Don't stop the driver while a Studio dialog is open.** Studio closes the dialog when the
  driver lets go of the browser. A draft is saved as it goes, so nothing is lost, but the dialog
  has to be opened again from Content. Only one driver runs at a time: a second one stops before
  it touches the browser, so to restart it, stop the running one first.

## Set up

Run these from `scripts/videos/`:

```powershell
npm run yt:browser          # Edge, with its own profile and DevTools on 127.0.0.1:9333
npm run yt:driver           # in an async shell, left running: it stays attached to the browser
npm run yt -- status        # signed in? on Fabricator? is a dialog open?
```

The first time on a machine the profile is new: ask the user to sign in to the channel's Google
account in the window `yt:browser` opened, then run `status` again. `npm run yt -- --list` lists
the steps.

## Publish a new lesson

Package it first (`npm run lesson:package -- <n>`). The steps that upload take the video,
thumbnail and captions from `out/lessons/<slug>/youtube/upload.json`, and refuse a package
older than the lesson's files; everything else, every step reads from the lesson's files as
they are. Then, in order:

| # | Run | What it does |
| --- | --- | --- |
| 1 | `npm run yt -- upload --lesson <n>` | Opens Studio's upload dialog and uploads the video. YouTube saves it as a private draft at once; the step logs its link. |
| 2 | `npm run yt -- details --lesson <n>` | Sets and checks the title, the description (replacing the channel's default), the thumbnail, the playlist, "not made for kids", no paid promotion, AI use, tags and category. It warns about anything it couldn't confirm, such as the video language. |
| 3 | `npm run yt -- subtitles --lesson <n>` | Uploads the `.en.vtt` with timing, and checks for "English by you". |
| 4 | `npm run yt -- endscreen --lesson <n>` | Puts the playlist over NEXT UP (the next lesson isn't up yet) and Subscribe over the round slot, from `upload.json`'s `endScreen.start` to the end. |
| 5 | `npm run yt -- visibility --as public` | Picks Public, and reports each step's state and YouTube's checks. It doesn't publish. |
| 6 | ask_user | Show the user the title, playlist, thumbnail, captions, audience, AI use, end screen, visibility and checks, and remind them that subscribers will be notified. |
| 7 | `npm run yt -- publish --confirm` | Publishes, and closes the "Video published" dialog. Only after their yes. |
| 8 | `lessons/channel.ts` | Add the video id to `lessons`. The steps read it fresh each time. |
| 9 | `npm run yt -- comment --lesson <n>` | Posts the challenge as the channel, and pins it. |
| 10 | `npm run yt -- endscreen --lesson <n-1> --video-id <its id> --replace` | Points the previous lesson's NEXT UP at this lesson. |
| 11 | `npm run yt -- check --lesson <n>`, then `--lesson <n-1>` | Checks both as viewers see them: public, title, captions, clickable links, chapters, the end screen on its slots, the pinned comment, and the playlist's order. |
| 12 | `lessons/SYLLABUS.md` | Set the lesson to Published with its link, and commit it with `channel.ts`. |

Look at each step's screenshot before running the next. If a step fails, read its error and
`error.png`. The steps skip what's already done where they can (`subtitles`, `comment`), so after
a fix you can run the step again.

## Update a published lesson

- **The end screen:** `npm run yt -- endscreen --lesson <n> --video-id <id> --replace`, with
  `--next <video id>` to choose the NEXT UP video yourself. It opens the video's details page,
  deletes the elements there, adds them again and saves; the editor's Save is all it needs. Add
  `--no-save` to look first; to drop that, click Discard changes and reload the page, because the
  editor keeps discarded elements until a reload.
- **The pinned comment:** change the challenge in the lesson's `youtube.ts`, delete the old
  comment in Studio (with the user's yes), and run `comment`. It stops, rather than posting a
  second one, while a different challenge from the channel is still there.
- **Title, description or tags:** change the lesson's files (`youtube.ts`; the description also
  takes the script's chapters and sources), so the repo stays the record. Then, with the user's
  yes, set them on the video's details page (`https://studio.youtube.com/video/<id>/edit`), which
  has the same Title and Description boxes as the upload dialog, with `npm run yt -- -e "…"`. In
  that code, `await studio.loadUpload(<n>)` gives the title, description and tags as the files
  say now. Look at the screenshot, and click the page's Save (`#save`). The lesson's `youtube.md`
  is remade by `lesson:package` after its next render (the video shows parts of `youtube.ts`, so
  packaging waits for one).
- **The thumbnail:** it's drawn from `youtube.ts`, so render and package the lesson again, then
  upload the new `thumbnail.jpg` on the details page.
- **Captions:** not scripted yet. In Studio, open the video's subtitles, remove the English
  track, and upload the new `.vtt` with timing.
- **A new cut of the video:** YouTube can't replace a video's file. Upload it as a new video and
  decide with the user what happens to the old one, which keeps its views, comments and links.

## How the tools work

- `yt:browser` starts Edge (or Chrome, or `YT_BROWSER`) with `--remote-debugging-port=9333` and a
  profile of its own; Chromium won't open DevTools on a default profile.
- `yt:driver` connects with Playwright (`playwright-core`, pinned) over the DevTools protocol, and
  stays connected. It takes 127.0.0.1:9334 before it attaches, so a second driver stops without
  touching the browser. It answers only requests that carry the token it writes next to the
  profile once it's attached, and runs one step at a time.
- `npm run yt -- <step>` sends a step. `steps/<step>.mjs` exports
  `async ({ page, context, shot, log, args, state }) => …`; `page` is Studio's tab, and `state`
  keeps things between steps, such as the watch-page tab. Steps, `lessons/channel.ts`,
  `lessons/series.ts` and the lessons' files are read fresh on every run. Restart the driver only
  after editing `driver.mjs`, `studio.mjs` or `config.mjs`: stop it (when no Studio dialog is
  open), then start it. `npm run yt -- -e "<code>"` runs code with the same names in scope, and
  `studio` (the helpers in `studio.mjs`), for looking around and one-off changes; a result that
  isn't JSON comes back as a note.
- The steps that don't upload files (`endscreen`, `comment`, `check`) work from the lesson's
  files alone, so they also run where it isn't packaged.

## What Studio does

Things learned the hard way, for when a step needs fixing:

- A tab in the background doesn't paint, so screenshots and drags wait on it forever. The driver
  brings a step's tab to the front.
- Every Studio page knows its account and channel: `ytcfg.get('LOGGED_IN')` and
  `ytcfg.get('CHANNEL_ID')`. The sidebar's text changes from page to page.
- The title and description are contenteditable boxes: `getByRole('textbox')` and `fill()` work.
- Clicks on Studio's checkboxes land on a wrapper, and the playlist picker's boxes have no names:
  click the label's text.
- The thumbnail and captions open a file chooser (wait for `filechooser`); the video takes
  `input[type=file]` directly.
- The upload dialog's steps are `#step-badge-0` to `#step-badge-3`. Its buttons are
  `#next-button`, `#back-button`, `#done-button` (Publish, or Save), `#subtitles-button` and
  `#endscreens-button`. The AI-use and paid-promotion answers are under "Show more"
  (`#toggle-button`).
- The end-screen editor (`ytve-modal-host`):
  - Its preview (`ytve-endscreen-editor-preview-overlay`) is the frame scaled to its width, about
    480 px. Each element (`ytve-endscreen-editor-preview-overlay-item`) sits where its inline
    `left`, `top`, `width` and `height` say, in preview pixels.
  - Video and playlist elements keep 16:9 and resize from `div.drag.bottom-right`. The subscribe
    element is a fixed circle, about 74 px.
  - The preview moves when the options panel changes height, so measure it again before each
    drag.
  - Times are `m:ss:ff`, typed into the options panel's two inputs.
  - A click on an element in the preview selects it; its row in the timeline is covered by a time
    handle. `#delete` deletes the selected element.
  - Deleted and discarded elements stay in the page until a reload: rows at opacity 0, and items
    without their `visible` class.
  - Elements that overlap, or sit too close, get "End Screen elements cannot overlap…", and
    won't save.
  - On a published video, the editor opens from `#endscreen-editor-link` on its details page.
- The Verify link in a "Get advanced features" dialog lands on the dashboard. Verification lives
  in Settings → Channel → Feature eligibility.
- A comment's ⋮ is the button named "Action menu", and Pin asks "Pin this comment?" to confirm.
  In a comment thread, `#author-text` is the author's handle, `#content-text` the text as
  written, and `#pinned-comment-badge` marks the pinned one.
