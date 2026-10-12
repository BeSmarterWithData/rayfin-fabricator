# Writing for Ray

Ray is Fabricator's mascot: a small spotted stingray, blue with a green tip to his tail. He lives
in the app, keeps people company while it works, and in this series he teaches. He's warm,
curious and a little goofy. He's excited about what he explains, but never sells it, and never
talks down. He teaches like a friend who just figured something out and can't wait to show you.

## His voice

Ray's voice is fixed in `lessons/series.ts`: ElevenLabs voice "Hale v3" on `eleven_v4` with seed
4242, the same as the intro, at tempo 1 (the intro is sped up 6%). Don't change it per lesson.

Audio tags in square brackets steer delivery. They're never spoken, captioned or transcribed. Put
one at the start of the clause it colors. These have worked well:

| Tag | Use it for | Ray's mood in the scene |
| --- | --- | --- |
| `[curious]` | A question that opens a lesson | `idle`, looking at the question |
| `[excited]` | Hooks, "Pop quiz!", "Let's dive in!" | `happy` |
| `[delighted]` | Hellos | `happy`, with a wave |
| `[relieved]` | The way out of a mess | `happy` |
| `[dizzy]` | Overwhelm, such as a tangle of tools | `dizzy`, with `DizzyStars` |
| `[impressed]`, `[gasps]` | A reveal | `surprised` |
| `[proudly]` | A payoff: "Just one class.", "You didn't lift a fin." | `happy`, with a hop |
| `[cheering]` | The quiz answer | `happy`, with hops and confetti |
| `[whispering]`, `[whispers]` | "Pause the video and guess…", the closing Ray fact | `idle` or `surprised` |
| `[giggles]` | After a joke | `happy`, with a squish |

Ray's other moods: `read` (with `glasses: true`, for reading code or logs), `worried` (something
failed), `love` (being petted), `talk`, `blow` and `sleep`. His mouth follows the voice in any
mood.

## How he talks

- **One idea per line**, under about 25 words: short lines are cheap to retake and easy to time.
- **Plain words, in the present tense, to "you".** Define a term the first time you use it.
- **Say what the docs say.** Prefer their own words for anything technical. Don't turn a hedge
  ("not available in every region", "experimental") into a promise.
- **No hype:** "simply", "easy", "powerful" and "seamless" are out, and so is "just" as a
  minimizer ("just run this"). "Just one class." as a punchline is fine.
- **At most two ocean puns a lesson.** His catchphrases count: "Let's dive in!", "You didn't lift
  a fin.", "Fins crossed.", "See you in the water!"
- **The Ray fact at the end must be true.** Take one from `RAY_FACTS` in
  `src/renderer/src/components/mascot/lines.ts`, or check a new one against marine-biology
  sources. Don't repeat one an earlier lesson used.

## Saying code out loud

- Name decorators in words: "the entity decorator", "the role decorator", "the text decorator".
  Don't write `@entity` in a line; the voice may read it as "at entity", and captions show the
  text as written.
- Write CLI commands in lowercase as they're typed: "rayfin up", "rayfin dev". They read as
  "ray-fin up".
- "GraphQL", "REST", "Microsoft Entra ID" and "Microsoft Fabric" read as they should. Say
  "Microsoft Fabric" the first time, then "Fabric".
- Spell out symbols ("an equals sign") or show them on screen instead.

## Recurring beats

| Beat | Typical line |
| --- | --- |
| Welcome | "[delighted] Hi, I'm Ray! Welcome back to Learn Rayfin with Ray." |
| Today | "[excited] Today: …, … and …. Let's dive in!" |
| Deep Dive | "[excited] Time for a deep dive! Let's see what …" |
| Fabricator | "Here's the same idea in Fabricator. …" |
| Quiz | "[excited] Pop quiz! …?" / "A, … B, … Or C, …" / "[whispering] Pause the video, and guess…" / "[cheering] It's …! …" |
| Recap | "Let's recap. …" |
| Challenge | "Your challenge: …" / "Then tell me in the comments: what did you build?" |
| Next | "Next time: …. [excited] See you in the water!" |
| Ray fact | "[whispers] Psst… … [giggles] …" |
