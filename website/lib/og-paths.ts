const TERMINAL = 'og.png';

export const OG_HOME_PATH = '/og.png';

export function ogImagePath(slugs: string[]): string {
  return `/og/${[...slugs, TERMINAL].join('/')}`;
}

export { TERMINAL as OG_TERMINAL };
