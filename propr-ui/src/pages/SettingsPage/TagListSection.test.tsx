import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import TagListSection from './TagListSection';

function Harness({ initial = [], onSave = vi.fn() }: { initial?: string[]; onSave?: (items: string[]) => void }) {
  const [items, setItems] = useState(initial);
  const [draft, setDraft] = useState('');
  const commit = (next: string[]) => { setItems(next); onSave(next); };
  return (
    <TagListSection
      title="Follow-up Keywords"
      description="Triggers processing when found in comments."
      items={items}
      newItem={draft}
      placeholder="e.g., PROPR"
      emptyMessage="No keywords configured."
      addLabel="Keyword"
      onNewItemChange={setDraft}
      onAddItem={(value = draft) => {
        const item = value.trim();
        if (!item || items.includes(item)) return;
        commit([...items, item]);
        setDraft('');
      }}
      onRemoveItem={item => commit(items.filter(i => i !== item))}
    />
  );
}

it('turns typed text into inline chips on Enter or comma, inside the input container', () => {
  const onSave = vi.fn();
  render(<Harness onSave={onSave} />);
  const input = screen.getByLabelText('Keyword');
  expect(screen.getByText('No keywords configured.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();

  fireEvent.change(input, { target: { value: 'PROPR' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.change(input, { target: { value: 'FIXIT,' } });

  expect(onSave).toHaveBeenLastCalledWith(['PROPR', 'FIXIT']);
  expect(input).toHaveValue('');
  const container = input.closest('[data-tag-input]');
  expect(container).toContainElement(screen.getByRole('button', { name: 'Remove PROPR' }));
  expect(screen.getByText('FIXIT')).toHaveClass('font-mono');
});

it('removes the last chip with Backspace and keeps typed text on blur', () => {
  const onSave = vi.fn();
  render(<Harness initial={['AI', 'bug']} onSave={onSave} />);
  const input = screen.getByLabelText('Keyword');

  fireEvent.keyDown(input, { key: 'Backspace' });
  expect(onSave).toHaveBeenLastCalledWith(['AI']);

  fireEvent.change(input, { target: { value: 'AI' } });
  expect(screen.getByText('“AI” is already in the list.')).toBeInTheDocument();
  fireEvent.change(input, { target: { value: 'docs' } });
  fireEvent.blur(input);
  expect(onSave).toHaveBeenLastCalledWith(['AI', 'docs']);
});
