import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RepositoryChip } from './RepositoryChip';

describe('RepositoryChip', () => {
  it('renders a monospace chip that hugs the repository name and carries the repository icon', () => {
    render(<RepositoryChip repository="integry/propr" />);

    const chip = screen.getByTestId('repository-chip');
    expect(chip).toHaveClass('inline-flex', 'font-mono', 'text-[12px]', 'bg-slate-100', 'border', 'border-slate-200', 'text-slate-800', 'rounded-sm', 'px-1.5', 'py-0.5');
    // A fixed or full width would stretch the background past the text.
    expect(chip).not.toHaveClass('block', 'w-full');
    expect(chip).toHaveAttribute('title', 'integry/propr');
    expect(chip).toHaveTextContent('integry/propr');
    expect(screen.getByTestId('repository-icon-fallback')).toBeInTheDocument();
  });

  it('shows the repository-provided icon when one is configured', () => {
    render(<RepositoryChip repository="integry/propr" iconPath="public/logo.svg" revision="main" />);

    expect(screen.getByTestId('repository-icon-image')).toHaveAttribute(
      'src',
      'https://raw.githubusercontent.com/integry/propr/main/public/logo.svg',
    );
  });
});
