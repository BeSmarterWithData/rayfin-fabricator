// Small presentational helpers for the footer status bar.

/**
 * The part of a team working branch worth showing.
 *
 * Working branches are `fabricator/<login>/<folder>-<YYYYMMDD>-<HHMMSS>`. The
 * timestamp only exists to make the name unique, so showing it spends a third
 * of the status bar on digits nobody reads. The folder is the part that tells
 * you which app you're on; the full branch stays in the tooltip.
 */
export function branchLabel(branch: string): string {
  const last = branch.split('/').pop() ?? branch
  return last.replace(/-\d{8}-\d{6}$/, '')
}
