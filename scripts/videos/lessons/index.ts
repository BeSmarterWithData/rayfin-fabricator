/**
 * The lessons, in order. Each one is a folder here (see SYLLABUS.md); `npm run lesson:new`
 * creates the folder and adds it to this list.
 */
import type { Lesson } from '../src/show/types';
import { lesson as lesson01 } from './01-what-is-rayfin';
import { lesson as lesson02 } from './02-your-first-app';

export const LESSONS: readonly Lesson[] = [lesson01, lesson02];
