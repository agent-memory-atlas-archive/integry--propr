import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PlanHistoryDialog } from './PlanHistoryDialog';
import { describeRevision } from './planRevisionLabels';

const api = vi.hoisted(() => ({
  listPlanRevisions: vi.fn(),
  getPlanRevision: vi.fn(),
}));

vi.mock('../../api/proprApi', () => api);

const refinementSnapshot = {
  revision_id: 7, draft_revision: 3, status_before: 'refining', status_after: 'review',
  replaced_at: '2026-09-28 10:00:00', issue_count: 2, titles: ['Add metrics', 'Trace tool calls'],
};

describe('PlanHistoryDialog', () => {
  beforeEach(() => {
    api.listPlanRevisions.mockReset().mockResolvedValue([refinementSnapshot]);
    api.getPlanRevision.mockReset().mockResolvedValue({
      ...refinementSnapshot,
      plan: [
        { id: 'a', title: 'Add metrics', body: 'Count MCP calls per tool', implementation: '' },
        { id: 'b', title: 'Trace tool calls', body: 'Emit spans', implementation: '' },
      ],
    });
  });

  test('previews an earlier version and restores it', async () => {
    const onRestore = vi.fn().mockResolvedValue(undefined);
    render(<PlanHistoryDialog isOpen draftId="draft-1" onClose={vi.fn()} onRestore={onRestore} />);

    const restoreButton = screen.getByRole('button', { name: /restore this version/i });
    expect(restoreButton).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: /before refinement/i }));
    expect(await screen.findByText('Count MCP calls per tool')).toBeInTheDocument();
    expect(api.getPlanRevision).toHaveBeenCalledWith('draft-1', 7);

    fireEvent.click(restoreButton);
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(7));
  });

  test('shows a restore failure and keeps restore disabled when read-only', async () => {
    const onRestore = vi.fn().mockRejectedValue(new Error('The plan cannot be restored while an operation is running'));
    const { rerender } = render(<PlanHistoryDialog isOpen draftId="draft-1" onClose={vi.fn()} onRestore={onRestore} />);
    fireEvent.click(await screen.findByRole('button', { name: /before refinement/i }));
    await screen.findByText('Emit spans');
    fireEvent.click(screen.getByRole('button', { name: /restore this version/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('while an operation is running');

    rerender(<PlanHistoryDialog isOpen draftId="draft-1" onClose={vi.fn()} onRestore={onRestore} isReadOnly />);
    expect(screen.getByRole('button', { name: /restore this version/i })).toBeDisabled();
  });

  test('explains an empty history', async () => {
    api.listPlanRevisions.mockResolvedValue([]);
    render(<PlanHistoryDialog isOpen draftId="draft-1" onClose={vi.fn()} onRestore={vi.fn()} />);
    expect(await screen.findByText(/no earlier versions yet/i)).toBeInTheDocument();
  });

  test('labels snapshots by the operation that replaced them', () => {
    expect(describeRevision({ status_before: 'generating', status_after: 'review' })).toBe('Before generation');
    expect(describeRevision({ status_before: 'review', status_after: 'review' })).toBe('Before edits');
    expect(describeRevision({ status_before: 'review', status_after: 'draft' })).toBe('Before returning to setup');
    expect(describeRevision({ status_before: 'approved', status_after: 'executing' })).toBe('Before publishing');
  });
});
