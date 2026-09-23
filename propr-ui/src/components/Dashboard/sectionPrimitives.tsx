/**
 * Shared row chrome for the dashboard sections.
 *
 * Row structure and metadata are deliberately the same vocabulary the inbox
 * uses — a metadata line of dot-separated facts, then a wrappable title, then
 * an optional secondary line — so a row means the same thing in both places.
 * Secondary metadata wraps or drops before a title is ever truncated.
 */

import React, { createContext, useContext } from 'react';
import { Link } from 'react-router-dom';
import { RepositoryIcon } from '../RepositoryIcon';
import { ReferenceChip } from '../TaskList/ReferenceChips';
import { SystemAlert } from '../ui/SystemAlert';
import { isExternalHref } from './sectionState';

/** Repository icons resolved once by the shell and read by every section. */
export interface RepositoryIconInfo {
  iconPath?: string | null;
  revision?: string | null;
}

const RepositoryIconContext = createContext<Map<string, RepositoryIconInfo>>(new Map());

export const RepositoryIconProvider: React.FC<{
  icons: Map<string, RepositoryIconInfo>;
  children: React.ReactNode;
}> = ({ icons, children }) => (
  <RepositoryIconContext.Provider value={icons}>{children}</RepositoryIconContext.Provider>
);

export const Dot: React.FC = () => <span className="text-gray-300" aria-hidden="true">•</span>;

/**
 * Repository slug as a monospace code chip.
 *
 * A repository is a technical entity, so it gets the same chip treatment as an
 * issue or a pull request rather than reading as prose. The icon rides inside
 * the chip so the two never separate when the metadata line wraps.
 *
 * `short` drops the owner and draws only the repository name. It is for the
 * narrow right rail, where `example/workspace` has to be cut to
 * `example/workspa…` to fit beside a status and an entity chip — eight
 * characters of organisation spent to make the eight characters that identify
 * the repository unreadable. The owner is the constant in any one instance, so
 * it is the part that can go; the full slug stays in the tooltip and in the
 * icon beside it.
 */
export const RepositoryLabel: React.FC<{ repository: string; short?: boolean }> = ({ repository, short = false }) => {
  const icons = useContext(RepositoryIconContext);
  const icon = icons.get(repository);
  const label = short ? repository.slice(repository.lastIndexOf('/') + 1) : repository;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap rounded-sm border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-[12px] leading-4 text-slate-800"
      title={repository}
    >
      <RepositoryIcon
        repository={repository}
        iconPath={icon?.iconPath}
        revision={icon?.revision}
        className="h-3.5 w-3.5 flex-none"
      />
      <span className="truncate">{label}</span>
    </span>
  );
};

/**
 * Issue or pull request reference, using the task list's code chip.
 *
 * The entity type is always spelled out. A bare `#2479` leaves the reader
 * guessing whether it is an issue or a pull request, so the prefix is not
 * optional — the chip is either `PR #n` or `Issue #n`.
 */
export const WorkReference: React.FC<{ issueNumber?: number | null; prNumber?: number | null }> = ({
  issueNumber,
  prNumber,
}) => {
  if (prNumber) return <ReferenceChip title={`Pull request #${prNumber}`}>PR #{prNumber}</ReferenceChip>;
  if (issueNumber) return <ReferenceChip title={`Issue #${issueNumber}`}>Issue #{issueNumber}</ReferenceChip>;
  return null;
};

/**
 * Utility header for a section.
 *
 * A ruled strip across the full width of its column, not the title of a
 * floating card: tinted background, a 1px rule beneath it, and the section's
 * own count carried inline as `HAPPENING NOW (6)` so a top-level number never
 * needs a box of its own. Zero is a count like any other: `NEEDS ATTENTION (0)`
 * above an all-clear line says the section looked and found nothing, where a
 * bare title leaves it ambiguous whether it ever loaded.
 *
 * `min-h-10` is the horizon line. Two panes sit side by side, and only some of
 * them carry a segmented control; without a shared minimum the header in one
 * column is 28px and the header beside it is 40px, so the rule under each one
 * lands on a different pixel and the split-pane reads as two separate boxes.
 * Forty is also the summary bar's height, so the whole console keeps one
 * chrome rhythm.
 */
export const SectionHeading: React.FC<{
  id: string;
  title: string;
  count?: number | null;
  children?: React.ReactNode;
}> = ({ id, title, count, children }) => (
  <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-slate-200 bg-slate-50 px-3 py-1.5">
    <h2 id={id} className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
      {title}
      {count !== undefined && count !== null && (
        <span className="tabular-nums"> ({count})</span>
      )}
    </h2>
    {children && <div className="flex items-center gap-2 text-xs">{children}</div>}
  </div>
);

export const SectionLink: React.FC<{ to: string; children: React.ReactNode }> = ({ to, children }) => (
  <Link to={to} className="font-medium text-gray-500 transition-colors hover:text-gray-800">
    {children}
  </Link>
);

/**
 * The bar that closes a list.
 *
 * Everything a section has to say after its last row — how much work is
 * queued, how many rows are still folded away — is said here, in one tinted
 * bar flush with the pane. A "Show N more" link left to float on its own
 * between the last row and a footer bar reads as a stray link dropped into
 * white space rather than as a control belonging to the list, so the section
 * gets one footer and the expand action lives inside it. The tint is what
 * marks it as a footer; it does not also need a rule above it.
 */
export const SectionFooter: React.FC<{
  children: React.ReactNode;
  'data-testid'?: string;
}> = ({ children, ...rest }) => (
  <div
    className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-slate-50 px-3 py-2 text-xs text-slate-600"
    {...rest}
  >
    {children}
  </div>
);

/** The expand/collapse control, sized and weighted to sit in a footer bar. */
export const SectionFooterButton: React.FC<{
  onClick: () => void;
  expanded: boolean;
  children: React.ReactNode;
}> = ({ onClick, expanded, children }) => (
  <button
    type="button"
    aria-expanded={expanded}
    onClick={onClick}
    className="-mx-1 rounded-sm px-1 font-medium text-slate-600 transition-colors hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
  >
    {children}
  </button>
);

/** Quiet, non-alarming empty state. An empty list is normal operation. */
export const SectionEmpty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="px-4 py-6 text-center text-sm text-slate-500">{children}</p>
);

/**
 * A failed read. This is deliberately worded and styled differently from an
 * empty list: "nothing is happening" and "we could not find out" are not the
 * same fact, and only one of them offers a retry.
 */
export const SectionError: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <div className="px-3 py-3">
    <SystemAlert onRetry={onRetry}>{message}</SystemAlert>
  </div>
);

export const SectionSkeleton: React.FC<{ rows?: number }> = ({ rows = 3 }) => (
  <div className="animate-pulse space-y-2 px-3 py-3" data-testid="section-skeleton">
    {Array.from({ length: rows }, (_, index) => (
      <div key={index} className="h-10 rounded-sm bg-slate-100" />
    ))}
  </div>
);

/**
 * Metadata line above a title. Secondary facts wrap or drop before a title truncates.
 *
 * `wrap={false}` keeps the whole line on one row from `lg` up, where the
 * attention panel is a 22rem column beside the main one: the repository chip
 * is the only shrinkable child (it carries `min-w-0` and truncates behind its
 * own tooltip), so the entity chip stays beside the repository instead of
 * being pushed onto a line of its own and making every row in that column a
 * line taller.
 *
 * Below `lg` the same panel is the full width of a phone, and forcing one row
 * there buys nothing: the row is already as tall as its title, and the only
 * effect is to cut the chips down to `design-s…`. So the line wraps at small
 * widths and only refuses to wrap where the column is what constrains it.
 */
export const RowMeta: React.FC<{ children: React.ReactNode; wrap?: boolean }> = ({ children, wrap = true }) => (
  <span
    className={`flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs ${
      wrap ? '' : 'lg:flex-nowrap lg:gap-y-0 lg:overflow-hidden'
    }`}
  >
    {children}
  </span>
);

/** Titles wrap to two lines rather than being cut off mid-word. */
export const RowTitle: React.FC<{ children: React.ReactNode; strong?: boolean }> = ({ children, strong = true }) => (
  <span className={`mt-1 line-clamp-2 block break-words text-sm leading-5 ${strong ? 'font-medium text-slate-900' : 'text-slate-700'}`}>
    {children}
  </span>
);

export const RowDetail: React.FC<{ children: React.ReactNode; clamp?: boolean }> = ({ children, clamp = true }) => (
  <span className={`mt-0.5 block break-words text-xs leading-5 text-slate-500 ${clamp ? 'line-clamp-1' : ''}`}>
    {children}
  </span>
);

/** One row destination, whether it lives in the app or on GitHub. */
export const RowLink: React.FC<{
  href: string;
  className?: string;
  children: React.ReactNode;
  'aria-label'?: string;
  'data-testid'?: string;
}> = ({ href, className = '', children, ...rest }) =>
  isExternalHref(href) ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className} {...rest}>
      {children}
    </a>
  ) : (
    <Link to={href} className={className} {...rest}>
      {children}
    </Link>
  );
