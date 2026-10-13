import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import SettingsSaveStatusBar from './SettingsSaveStatusBar';

describe('SettingsSaveStatusBar', () => {
  test('reads "All changes saved" whether or not this visit has saved yet', () => {
    const view = render(<SettingsSaveStatusBar saveStatus="idle" globalError={null} />);
    expect(screen.getByRole('status')).toHaveTextContent(/^All changes saved$/);

    view.rerender(<SettingsSaveStatusBar saveStatus="saved" globalError={null} />);
    expect(screen.getByRole('status')).toHaveTextContent(/^All changes saved$/);
  });

  test('still reports saving, warnings and errors', () => {
    const view = render(<SettingsSaveStatusBar saveStatus="saving" globalError={null} />);
    expect(screen.getByText('Saving changes...')).toBeInTheDocument();

    view.rerender(<SettingsSaveStatusBar saveStatus="error" globalError="Network down" />);
    expect(screen.getByRole('status')).toHaveTextContent('Network down');
  });
});
