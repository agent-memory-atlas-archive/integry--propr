/**
 * Happening now: the operational view of work in flight.
 *
 * Rows show only facts the system actually has — lifecycle phase, elapsed time
 * and the latest progress line the agent reported. There is no synthesised
 * percentage, and a run with no recent chat message is not called stalled:
 * missing progress means the progress is unknown, not that the work is stuck.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { getDashboardActive, type ActiveItem, type DashboardActiveResponse } from '../../api/dashboardApi';
import {
  RepositoryLabel,
  RowDetail,
  RowLink,
  RowMetaLines,
  RowTitle,
  SectionEmpty,
  SectionError,
  SectionFooter,
  SectionFooterButton,
  SectionHeading,
  SectionLink,
  SectionSkeleton,
  WorkReference,
} from './sectionPrimitives';
import {
  type DashboardSectionProps,
  elapsedRunning,
  filteredTasksHref,
  shortenPaths,
  useDashboardSection,
  useNowTick,
  useStableOrder,
  workHref,
} from './sectionState';

/** Active rows shown before the list has to be expanded. */
const VISIBLE_ITEMS = 5;

/**
 * Rows the list will simply draw rather than fold behind a control.
 *
 * A "Show 1 more" toggle costs a line of chrome to save a line of content and
 * asks for a click to reveal a single row. Past the slack the toggle earns its
 * place; at or below it the row is just shown.
 */
const OVERFLOW_SLACK = 1;

const itemKey = (item: ActiveItem): string => item.id;

const itemTitle = (item: ActiveItem): string =>
  item.title || (item.prNumber ? `Pull request #${item.prNumber}` : item.issueNumber ? `Issue #${item.issueNumber}` : 'Untitled work');

const ActiveRow: React.FC<{
  item: ActiveItem;
  expanded: boolean;
  onToggle: (id: string) => void;
}> = ({ item, expanded, onToggle }) => (
  <li>
    <div className="flex min-w-0 items-start gap-1">
      <RowLink href={workHref(item)} className="block min-w-0 flex-1 px-3 py-2.5 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500">
        <RowMetaLines
          /*
            A spinner, not a dot: a filled circle reads as a status light, and a
            green one reads as "done". Motion is unambiguous about work in flight.
          */
          status={(
            <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-teal-700">
              <Loader2 className="h-3 w-3 flex-none animate-spin" aria-hidden="true" />
              <span className="truncate">{item.phase || 'Running'}</span>
            </span>
          )}
          entities={(
            <>
              <RepositoryLabel repository={item.repository} shortOnMobile />
              <WorkReference issueNumber={item.issueNumber} prNumber={item.prNumber} />
            </>
          )}
          trailing={(
            <span title={`Started ${new Date(item.createdAt).toLocaleString()}`}>
              {elapsedRunning(item.createdAt)}
            </span>
          )}
        />
        <RowTitle>{itemTitle(item)}</RowTitle>
        {/*
          The progress line is a sentence with a repository path in it, and on a
          phone the path is most of the sentence: 110 characters of
          `propr-ui/src/components/…` wrapped to three lines of the densest text
          on the screen. Someone triaging on a phone needs the file, not the
          route to it, so the directories collapse below `sm` and come back
          whole where there is width for them.
        */}
        {item.progressLine && (
          <RowDetail clamp={!expanded}>
            <span className="sm:hidden">{shortenPaths(item.progressLine)}</span>
            <span className="hidden sm:inline">{item.progressLine}</span>
          </RowDetail>
        )}
      </RowLink>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${itemTitle(item)}`}
        onClick={() => onToggle(item.id)}
        className="mt-1.5 mr-1 inline-flex h-8 w-8 flex-none items-center justify-center rounded-sm text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
      >
        <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
    </div>
    {expanded && (
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 px-3 pb-3 text-xs text-slate-600">
        <dt className="text-gray-500">Phase</dt>
        <dd>{item.phase || 'Running'}</dd>
        <dt className="text-gray-500">Started</dt>
        <dd>{new Date(item.createdAt).toLocaleString()}</dd>
        <dt className="text-gray-500">Last update</dt>
        <dd>{new Date(item.updatedAt).toLocaleString()}</dd>
        <dt className="text-gray-500">Progress</dt>
        {/* An absent progress line is unknown progress, not a stall. */}
        <dd>{item.progressLine || 'No progress reported yet'}</dd>
      </dl>
    )}
  </li>
);

/**
 * The one footer under the running list.
 *
 * Waiting work is summarised rather than listed, and the control that unfolds
 * the rest of the list rides in the same bar. Two pieces of after-the-list
 * chrome — a floating link above a tinted strip — read as an accident; one bar
 * reads as the end of the pane.
 */
const HappeningNowFooter: React.FC<{
  queuedCount: number;
  reason: string | null;
  repository: string;
  overflowCount: number;
  expanded: boolean;
  onToggle: () => void;
}> = ({ queuedCount, reason, repository, overflowCount, expanded, onToggle }) => {
  const showToggle = overflowCount > 0;
  if (queuedCount === 0 && !showToggle) return null;
  return (
    <SectionFooter data-testid="happening-now-footer">
      {queuedCount > 0 && (
        <span data-testid="queue-summary" className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`font-medium text-slate-700 ${reason ? 'border-r border-slate-300 pr-2' : ''}`}>
            {queuedCount} queued
          </span>
          {reason && <span>{reason}</span>}
        </span>
      )}
      <span className="ml-auto flex items-center gap-x-3">
        {showToggle && (
          <SectionFooterButton expanded={expanded} onClick={onToggle}>
            {expanded ? 'Show fewer' : `Show ${overflowCount} more`}
          </SectionFooterButton>
        )}
        {queuedCount > 0 && (
          <SectionLink to={filteredTasksHref('waiting', repository)}>View queue</SectionLink>
        )}
      </span>
    </SectionFooter>
  );
};

export const HappeningNowSection: React.FC<DashboardSectionProps> = ({ repository, refreshToken, onLoaded }) => {
  const load = useCallback(() => getDashboardActive(repository), [repository]);
  const { data, error, loading, reload } = useDashboardSection<DashboardActiveResponse>(
    load,
    repository,
    refreshToken,
    onLoaded,
  );
  const [showAll, setShowAll] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // Elapsed times advance between reads.
  useNowTick();

  const running = useMemo(() => data?.running ?? [], [data]);
  const orderedRunning = useStableOrder(running, itemKey);
  // One row over the limit is drawn, not folded: see OVERFLOW_SLACK.
  const canCollapse = orderedRunning.length > VISIBLE_ITEMS + OVERFLOW_SLACK;
  const collapsedLimit = canCollapse ? VISIBLE_ITEMS : orderedRunning.length;
  const overflowCount = canCollapse ? orderedRunning.length - VISIBLE_ITEMS : 0;

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const heading = (
    <SectionHeading id="happening-now-heading" title="Happening now" count={data?.counts.running ?? null}>
      <SectionLink to={filteredTasksHref('active', repository)}>View all</SectionLink>
    </SectionHeading>
  );

  const body = () => {
    if (loading) return <SectionSkeleton rows={3} />;
    // "We could not find out" is not the same as "nothing is running", so the
    // failed read keeps its own wording and its own retry.
    if (error && orderedRunning.length === 0) {
      return <SectionError message="Unable to load running work" onRetry={reload} />;
    }
    if (orderedRunning.length === 0) {
      return <SectionEmpty>No work running</SectionEmpty>;
    }

    const visible = showAll ? orderedRunning : orderedRunning.slice(0, collapsedLimit);
    return (
      <ul data-testid="happening-now-list">
        {visible.map(item => (
          <ActiveRow
            key={item.id}
            item={item}
            expanded={expandedIds.has(item.id)}
            onToggle={toggleExpanded}
          />
        ))}
      </ul>
    );
  };

  return (
    <section
      aria-labelledby="happening-now-heading"
      data-testid="happening-now-section"
      className="min-w-0 bg-white"
    >
      {heading}
      {body()}
      {data && (
        <HappeningNowFooter
          queuedCount={data.queue.queuedCount}
          reason={data.queue.reason}
          repository={repository}
          overflowCount={overflowCount}
          expanded={showAll}
          onToggle={() => setShowAll(value => !value)}
        />
      )}
    </section>
  );
};

export default HappeningNowSection;
