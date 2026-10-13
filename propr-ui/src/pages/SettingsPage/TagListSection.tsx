import React, { useRef } from 'react';
import { X } from 'lucide-react';
import { SettingsSection } from './SettingsLayout';
import { SETTINGS_FIELD, SETTINGS_HELPER, SETTINGS_LABEL } from './settingsStyles';

interface TagListSectionProps {
  title: string;
  description: string;
  items: string[];
  newItem: string;
  placeholder: string;
  emptyMessage: string;
  helperText?: string;
  /** Label for the entry input. Defaults to a generic "Add an entry". */
  addLabel?: string;
  onNewItemChange: (value: string) => void;
  /** Commits `value`, or the typed text when omitted. Blank and duplicate entries are ignored. */
  onAddItem: (value?: string) => void;
  onRemoveItem: (item: string) => void;
  className?: string;
}

/**
 * A tag input: committed entries sit as monospace chips inside the same
 * container as the text field. Enter or a comma turns the typed text into a
 * chip, Backspace on an empty field removes the last chip, and leaving the
 * field keeps whatever was typed.
 */
const TagListSection: React.FC<TagListSectionProps> = ({
  title,
  description,
  items,
  newItem,
  placeholder,
  emptyMessage,
  helperText,
  addLabel = 'Add an entry',
  onNewItemChange,
  onAddItem,
  onRemoveItem,
  className
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = `tag-list-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const helperId = `${inputId}-helper`;
  const isDuplicate = items.includes(newItem.trim());

  const handleChange = (value: string): void => {
    const comma = value.indexOf(',');
    if (comma === -1) {
      onNewItemChange(value);
      return;
    }
    // A comma typed on any keyboard (or pasted) commits the text before it.
    onAddItem(value.slice(0, comma));
    onNewItemChange(value.slice(comma + 1).trimStart());
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onAddItem();
    } else if (event.key === 'Backspace' && newItem === '' && items.length > 0) {
      event.preventDefault();
      onRemoveItem(items[items.length - 1]);
    }
  };

  return (
    <SettingsSection title={title} description={description} className={className}>
      <div className={SETTINGS_FIELD}>
        <label className={SETTINGS_LABEL} htmlFor={inputId}>{addLabel}</label>
        <div
          data-tag-input
          onClick={() => inputRef.current?.focus()}
          className="mt-1.5 flex min-h-[34px] w-full cursor-text flex-wrap items-center gap-1.5 rounded border border-slate-300 bg-white px-2 py-1 shadow-sm focus-within:border-primary-500 focus-within:ring-1 focus-within:ring-primary-500"
        >
          {items.map(item => (
            <span
              key={item}
              className="inline-flex items-center rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-medium text-slate-700"
            >
              {item}
              <button
                type="button"
                onClick={(event) => { event.stopPropagation(); onRemoveItem(item); }}
                className="ml-1.5 inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-300 hover:text-slate-700 focus:bg-slate-400 focus:text-white focus:outline-none"
              >
                <span className="sr-only">Remove {item}</span>
                <X aria-hidden="true" className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            id={inputId}
            value={newItem}
            onChange={(event) => handleChange(event.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => { if (newItem.trim()) onAddItem(); }}
            placeholder={items.length === 0 ? placeholder : ''}
            aria-describedby={helperId}
            enterKeyHint="done"
            className="min-w-[8rem] flex-1 border-0 bg-transparent px-0.5 py-0.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-0 disabled:cursor-not-allowed"
          />
        </div>

        <p id={helperId} className={SETTINGS_HELPER}>
          {isDuplicate && newItem.trim()
            ? `“${newItem.trim()}” is already in the list.`
            : items.length === 0 ? emptyMessage : 'Press Enter or comma to add.'}
          {helperText && <> {helperText}</>}
        </p>
      </div>
    </SettingsSection>
  );
};

export default TagListSection;
