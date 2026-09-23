/**
 * Summary sub-toolbar: four counts, each one a door into the list behind it.
 *
 * These are four single numbers, so they get one line — not four boxes, and
 * not four cells with a rule between each pair. Space separates them.
 *
 * The strip is a container, not a line of text that happens to sit between the
 * connection status and the first pane. It is a 36px bar with a rule on both
 * edges and its own tint, so the white toolbar above it and the white canvas
 * of the panes below it both stop at a visible line: without the top rule the
 * bar bled upwards into the toolbar and the counts read as loose text hovering
 * under "Reconnecting". The tint is a step darker than the pane headings
 * underneath it — white toolbar, slate-100 console bar, slate-50 pane headers,
 * white rows — because the one bar that speaks for the whole console should
 * not be mistaken for one more pane heading. Counts stay neutral; only "Needs
 * attention" takes colour, and only when it is non-zero — if everything is
 * emphasised, nothing is.
 *
 * The bar's own `px-3` left rail is the same one every section heading below
 * it uses, so `NEEDS ATTENTION` in the bar sits on the same vertical line as
 * `HAPPENING NOW` in the pane underneath. The counts themselves carry no
 * padding of their own, only a hover inset, so that rail is not doubled.
 *
 * It wraps below `sm`, where four counts cannot share 320px, so the bar grows
 * to two rows instead of scrolling sideways — `min-h-9` rather than a fixed
 * height is what lets it.
 */

import React, { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { getDashboardSummary, type DashboardSummaryResponse } from '../../api/dashboardApi';
import {
  type DashboardSectionProps,
  filteredTasksHref,
  useDashboardSection,
} from './sectionState';

interface SummaryCountProps {
  label: string;
  value: number | null;
  href: string;
  title: string;
  emphasised?: boolean;
  testId: string;
}

const SummaryCount: React.FC<SummaryCountProps> = ({ label, value, href, title, emphasised = false, testId }) => (
  <Link
    to={href}
    title={title}
    data-testid={testId}
    data-emphasis={emphasised ? 'true' : 'false'}
    className={`-mx-1 flex min-w-0 items-baseline gap-1.5 rounded-sm px-1 py-0.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${
      emphasised ? 'hover:bg-amber-100' : 'hover:bg-slate-200/80'
    }`}
  >
    <span
      className={`truncate text-[10px] font-bold uppercase tracking-wider ${
        emphasised ? 'text-amber-700' : 'text-slate-500'
      }`}
    >
      {label}
    </span>
    <span
      className={`font-mono text-sm font-semibold tabular-nums ${
        emphasised ? 'text-amber-700' : 'text-slate-900'
      }`}
    >
      {value === null ? <span className="text-slate-300">—</span> : value}
    </span>
  </Link>
);

export const SummaryStrip: React.FC<DashboardSectionProps> = ({ repository, refreshToken, onLoaded }) => {
  const load = useCallback(() => getDashboardSummary(repository), [repository]);
  const { data, error } = useDashboardSection<DashboardSummaryResponse>(load, repository, refreshToken, onLoaded);

  // A failed read leaves the counts unknown. An unknown count is rendered as
  // unknown, never as zero.
  const counts = error && !data ? null : data;
  const windowHours = data?.recentWindowHours ?? 24;

  return (
    <div
      aria-label="Work summary"
      data-testid="summary-strip"
      className="flex min-h-9 flex-wrap items-center gap-x-5 gap-y-1 border-y border-slate-200 bg-slate-100 px-3 py-1.5"
    >
      <SummaryCount
        testId="summary-needs-attention"
        label="Needs attention"
        value={counts?.needsAttention ?? null}
        emphasised={(counts?.needsAttention ?? 0) > 0}
        href={filteredTasksHref('attention', repository)}
        title="Work that is blocked or waiting on a decision"
      />
      <SummaryCount
        testId="summary-running"
        label="Running"
        value={counts?.running ?? null}
        href={filteredTasksHref('active', repository)}
        title="Work running right now"
      />
      <SummaryCount
        testId="summary-queued"
        label="Queued"
        value={counts?.queued ?? null}
        href={filteredTasksHref('waiting', repository)}
        title="Work waiting for an agent"
      />
      <SummaryCount
        testId="summary-completed"
        label={windowHours === 24 ? 'Completed today' : `Completed (${windowHours}h)`}
        value={counts?.completedRecently ?? null}
        href={filteredTasksHref('completed', repository)}
        title={`Work completed in the last ${windowHours} hours`}
      />
    </div>
  );
};

export default SummaryStrip;
