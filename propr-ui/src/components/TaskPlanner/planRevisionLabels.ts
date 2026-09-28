import type { PlanRevisionSummary } from '../../api/proprApi';

/** Names a history snapshot by the operation that replaced it. */
export const describeRevision = (revision: Pick<PlanRevisionSummary, 'status_before' | 'status_after'>): string => {
  const { status_before: before, status_after: after } = revision;
  if (before === 'refining') return 'Before refinement';
  if (before === 'generating') return 'Before generation';
  if (after === 'draft') return 'Before returning to setup';
  if (after === 'executing' || after === 'executed') return 'Before publishing';
  if (before === after) return 'Before edits';
  return `Before ${after ?? 'change'}`;
};
