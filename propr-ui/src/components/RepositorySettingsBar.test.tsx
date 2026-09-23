import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { MonitoredRepo } from '../api/proprApi';
import { RepositorySettingsBar } from './RepositorySettingsBar';

const repo: MonitoredRepo = {
  id: 'repo-1',
  name: 'integry/propr',
  enabled: true,
  visualPreview: { enabled: false, types: ['image'] }
};

function renderBar(overrides: Partial<MonitoredRepo> = {}, isReadOnly = false) {
  const onToggleCancelCiDuringFollowup = vi.fn();
  render(
    <MemoryRouter>
      <RepositorySettingsBar
        repo={{ ...repo, ...overrides }}
        indexingStatus={undefined}
        onToggle={vi.fn()}
        onRemove={vi.fn()}
        onStopIndexing={vi.fn()}
        onReindex={vi.fn()}
        onToggleStar={vi.fn()}
        onToggleHidden={vi.fn()}
        onToggleAutoCiFollowup={vi.fn()}
        onToggleCancelCiDuringFollowup={onToggleCancelCiDuringFollowup}
        onToggleNotifications={vi.fn()}
        onUpdateVisualPreview={vi.fn()}
        isReadOnly={isReadOnly}
      />
    </MemoryRouter>
  );
  return { onToggleCancelCiDuringFollowup };
}

const controlName = 'Cancel CI during follow-up implementation for integry/propr';

describe('RepositorySettingsBar follow-up CI cancellation', () => {
  it('renders the option off by default with helper text about restarting checks', () => {
    renderBar();

    const toggle = screen.getByRole('checkbox', { name: controlName });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('Cancel CI while follow-up implementation is in progress')).toBeInTheDocument();
    expect(screen.getByText(/Checks start again on the new commit, or resume on the current one if no commit is produced\./)).toBeInTheDocument();
  });

  it('reflects the stored value and reports a toggle', () => {
    const { onToggleCancelCiDuringFollowup } = renderBar({ cancelCiDuringFollowup: true });

    const toggle = screen.getByRole('checkbox', { name: controlName });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    expect(onToggleCancelCiDuringFollowup).toHaveBeenCalledWith('repo-1');
  });

  it('hides the option for viewers who cannot manage repositories', () => {
    renderBar({}, true);

    expect(screen.queryByRole('checkbox', { name: controlName })).not.toBeInTheDocument();
  });
});
