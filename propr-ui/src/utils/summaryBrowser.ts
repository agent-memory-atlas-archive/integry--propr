export const LEGACY_SUMMARY_BRANCH = 'HEAD';

// Git forbids ASCII whitespace in refs, but Unicode whitespace (e.g. U+00A0)
// is a valid branch character and must survive normalization.
const ASCII_WHITESPACE_EDGES = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

export function normalizeSummaryBranch(branch: string | null | undefined): string | undefined {
  if (typeof branch !== 'string') return undefined;
  const normalized = branch.replace(ASCII_WHITESPACE_EDGES, '');
  return normalized || undefined;
}

/**
 * Resolve a Browse branch in the same order for every entry point.
 * An undefined result deliberately preserves the API's legacy HEAD fallback.
 */
export function resolveSummaryBranch(
  requestedBranch?: string | null,
  configuredBranch?: string | null,
): string | undefined {
  return normalizeSummaryBranch(requestedBranch) ?? normalizeSummaryBranch(configuredBranch);
}

export function summaryBrowserPath(owner: string, repo: string, branch?: string | null): string {
  const path = `/summaries/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const normalizedBranch = normalizeSummaryBranch(branch);
  return normalizedBranch ? `${path}?branch=${encodeURIComponent(normalizedBranch)}` : path;
}
