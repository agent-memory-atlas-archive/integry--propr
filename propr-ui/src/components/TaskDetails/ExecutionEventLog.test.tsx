import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ExecutionEventLog from './ExecutionEventLog';
import ThinkingLog from './ThinkingLog';
import type { LiveEvent } from './types';

const defaultProps = {
  onToggleCollapse: vi.fn(),
  lastThought: null,
  isTaskActive: true,
  taskInfo: null,
};

describe('ExecutionEventLog', () => {
  it('does not materialize historical event details while collapsed', () => {
    const commandRead = vi.fn();
    const input = Object.defineProperty({}, 'command', {
      configurable: true,
      enumerable: true,
      get: () => {
        commandRead();
        return 'npm test';
      },
    });
    const events: LiveEvent[] = [
      { id: 'tool-1', type: 'tool_use', toolName: 'Bash', input },
      { id: 'thought-2', type: 'thought', content: 'Waiting for the test result' },
    ];

    const { rerender } = render(
      <ExecutionEventLog {...defaultProps} events={events} collapsed={true} />,
    );

    expect(screen.getByText('EXECUTION LOG (2)')).toBeTruthy();
    expect(commandRead).not.toHaveBeenCalled();
    expect(document.querySelector('#execution-event-log-content')?.children).toHaveLength(1);
    expect(screen.queryByText('BASH')).toBeNull();

    rerender(<ExecutionEventLog {...defaultProps} events={events} collapsed={false} />);

    expect(commandRead).toHaveBeenCalled();
    expect(screen.getByText('TERMINAL OUTPUT (2)')).toBeTruthy();
    expect(screen.getByText('BASH')).toBeTruthy();
  });

  it('keeps the collapsed summary interactive without rendering the hidden history', () => {
    const onToggleCollapse = vi.fn();
    render(
      <ExecutionEventLog
        {...defaultProps}
        events={[{ id: 'thought-1', type: 'thought', content: 'A current summary' }]}
        collapsed={true}
        onToggleCollapse={onToggleCollapse}
      />,
    );

    expect(screen.getByText('Thinking: A current summary')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /execution log/i }));
    expect(onToggleCollapse).toHaveBeenCalledOnce();
  });

  it('discloses output discarded by retention instead of implying the count is complete', () => {
    const events: LiveEvent[] = [{ id: 'tool-1', type: 'tool_use', toolName: 'Bash', input: { command: 'npm test' } }];
    const { rerender } = render(<ExecutionEventLog {...defaultProps} events={events} collapsed={false} omittedEventCount={0} historyTruncated />);
    expect(screen.getByText('TERMINAL OUTPUT (1+)')).toBeTruthy();
    const notice = screen.getByRole('note');
    expect(notice.textContent).toContain('Earlier output from this run exceeded the live log size limit and was discarded.');
    expect(notice.textContent).not.toContain('keeps every message');

    rerender(<ExecutionEventLog {...defaultProps} events={events} collapsed={false} omittedEventCount={3} />);
    expect(screen.getByText('TERMINAL OUTPUT (4)')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toBe('3 earlier terminal events are not shown. The implementation log keeps every message.');
  });
});

describe('ThinkingLog', () => {
  it('discloses output discarded by retention in the readable view', () => {
    const events: LiveEvent[] = [{ id: 'thought-1', type: 'thought', content: 'Still working' }];
    const { rerender } = render(<ThinkingLog events={events} historyTruncated />);
    expect(screen.getByRole('note').textContent).toContain('The oldest messages may be missing.');
    rerender(<ThinkingLog events={events} />);
    expect(screen.queryByRole('note')).toBeNull();
  });
});
