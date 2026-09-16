import { describe, expect, test } from 'vitest';
import { resolveSummaryBranch, summaryBrowserPath } from './summaryBrowser';

describe('summary browser branch resolution', () => {
  test('prefers an explicit branch, then the configured branch', () => {
    expect(resolveSummaryBranch('feature/explicit', 'main')).toBe('feature/explicit');
    expect(resolveSummaryBranch(undefined, 'release/2026')).toBe('release/2026');
  });

  test('preserves legacy fallback when neither branch is available', () => {
    expect(resolveSummaryBranch('', '  ')).toBeUndefined();
    expect(summaryBrowserPath('integry', 'propr')).toBe('/summaries/integry/propr');
  });

  test('URL-encodes branch names in standalone links', () => {
    expect(summaryBrowserPath('integry', 'propr', 'release/2026 Q1'))
      .toBe('/summaries/integry/propr?branch=release%2F2026%20Q1');
  });

  test('preserves Unicode whitespace that Git allows in branch names', () => {
    expect(resolveSummaryBranch('feature/a\u00a0', undefined)).toBe('feature/a\u00a0');
    expect(resolveSummaryBranch(undefined, '\tfeature/a\u00a0\n')).toBe('feature/a\u00a0');
    expect(summaryBrowserPath('integry', 'propr', 'feature/a\u00a0'))
      .toBe('/summaries/integry/propr?branch=feature%2Fa%C2%A0');
  });
});
