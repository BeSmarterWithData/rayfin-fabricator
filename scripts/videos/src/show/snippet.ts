/** Code a lesson shows on screen. Pure, so tools/lesson-snippets.mjs can type-check it. */
export interface Snippet {
  /**
   * Where the file lives in a Universal App project, as the code card's header shows it.
   * Snippets are checked side by side, so one can import another by its file name.
   */
  file: string;
  code: string;
  /**
   * Compiled with the others but never shown: proof of something a scene claims, such as
   * which methods the typed client has.
   */
  hidden?: boolean;
}
