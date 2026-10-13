/**
 * Where the lessons are published: Fabricator's YouTube channel, the series' playlist, and the
 * video each published lesson became. The YouTube tools (tools/youtube/) read it. It's kept
 * apart from series.ts, which the lessons render from, so recording an upload here never makes
 * a rendered lesson stale.
 */
export interface Channel {
  /** The channel's name, as YouTube shows it beside a comment. */
  name: string;
  id: string;
  handle: string;
  playlist: { id: string; title: string };
  /** The Fabricator intro, first in the playlist. */
  intro: string;
  /** Each published lesson's video id, by lesson number. */
  lessons: Readonly<Record<number, string>>;
  /**
   * The answer to YouTube Studio's "AI use" question. YouTube asks whether AI made a real person
   * appear to say or do something, altered footage of a real event or place, generated a
   * realistic scene that didn't happen, or created music that's the main focus. The lessons are
   * animated, Ray is a cartoon, and the music is a bed under his voice, so the channel's owner
   * chose "no" for lesson 1 (October 2026). Ask them again before publishing a lesson that
   * changes any of that.
   */
  aiUse: 'yes' | 'no';
}

export const CHANNEL: Channel = {
  name: 'Fabricator',
  id: 'UCbkqoj2jPG5n81qFgBJjpCA',
  handle: '@RayfinFabricator',
  playlist: { id: 'PLXW2FECmSE6Q', title: 'Learn Rayfin with Ray' },
  intro: '4T1oQmT8Bks',
  lessons: {
    1: 'n-VtBCmtn78',
    2: '-PzsntUZT7w',
  },
  aiUse: 'no',
};
