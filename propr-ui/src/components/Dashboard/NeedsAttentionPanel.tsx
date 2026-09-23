/**
 * Needs attention: the short list of things only a person can resolve.
 *
 * The list is derived from work state, never from notification state, so
 * dismissing something in the inbox does not make a blocker disappear here.
 *
 * The panel is a fixed structural block, not a conditional one. It is the top
 * module of the console's right column, and unmounting it when the list
 * empties collapsed that column: the stats panel floated up into the triage
 * slot, the row rule the two columns share went with it, and the bottom of
 * the rail became a band of white with a vertical rule running down through
 * it. So an empty list is drawn, not removed — one quiet line inside the same
 * heading, holding the same geometry as four rows would.
 */

import React, { useCallback } from 'react';
import { ShieldCheck } from 'lucide-react';
import { getDashboardAttention, type AttentionItem, type DashboardAttentionResponse } from '../../api/dashboardApi';
import {
  RepositoryLabel,
  RowLink,
  RowMeta,
  RowTitle,
  SectionError,
  SectionHeading,
  SectionLink,
  SectionSkeleton,
  SectionZeroState,
  WorkReference,
} from './sectionPrimitives';
import {
  type DashboardSectionProps,
  elapsedLabel,
  filteredTasksHref,
  isExternalHref,
  useDashboardSection,
  useNowTick,
  workHref,
} from './sectionState';

/** How many items the panel shows before handing off to the full list. */
const VISIBLE_ITEMS = 3;

const REASON_LABELS: Record<AttentionItem['kind'], string> = {
  task_failed: 'Run failed',
  task_action_required: 'Waiting on you',
  plan_review: 'Review requested',
};

/**
 * One word, always.
 *
 * The button sits in a fixed right rail, so the label has to be a fixed-width
 * verb: "Open task" beside "Review pull request" moved every button's left
 * edge by ten characters and made the column look unaligned. What is being
 * opened or reviewed is already named by the row's chip and title directly
 * above, so the entity belongs in the accessible name, not on the button face.
 */
function actionLabel(item: AttentionItem): string {
  return item.kind === 'plan_review' ? 'Review' : 'Open';
}

/**
 * The entity the verb acts on.
 *
 * It rides in the button's `aria-label` rather than in a visually hidden span:
 * a hidden span is joined to the visible verb without a separator by the
 * accessible-name algorithm, which announces "Openissue #42".
 */
function actionContext(item: AttentionItem): string {
  if (item.prNumber) return `pull request #${item.prNumber}`;
  if (item.issueNumber) return `issue #${item.issueNumber}`;
  return 'task';
}

/** The review decision lives on GitHub; everything else resolves in a task. */
function actionHref(item: AttentionItem): string {
  if (item.kind === 'plan_review') {
    if (item.prNumber) return `https://github.com/${item.repository}/pull/${item.prNumber}`;
    if (item.issueNumber) return `https://github.com/${item.repository}/issues/${item.issueNumber}`;
  }
  return workHref(item);
}

function itemTitle(item: AttentionItem): string {
  if (item.title) return item.title;
  if (item.prNumber) return `Pull request #${item.prNumber}`;
  if (item.issueNumber) return `Issue #${item.issueNumber}`;
  return 'Untitled work';
}

const AttentionRow: React.FC<{ item: AttentionItem }> = ({ item }) => {
  const href = actionHref(item);
  const external = isExternalHref(href);
  return (
    <li>
      <div className="px-3 py-2.5">
        {/*
          One line, like the row in "Happening now": reason, repository, entity.
          The panel lives in the narrow column, so without `wrap={false}` the
          entity chip drops to a line of its own and every row here is a line
          taller than the same row in the main column.

          Three chips do not fit 320px at full length, and the one that loses
          the fight is the repository: `example/workspa…` identifies nothing.
          So the chip here is `short` — the repository name without its owner,
          which is the same eight characters on every row of a given instance.
          That buys the line enough room for all three chips to sit whole,
          with the full slug still in the chip's tooltip.
        */}
        <RowMeta wrap={false}>
          <span
            className={`flex-none whitespace-nowrap font-semibold ${
              item.category === 'blocked' ? 'text-amber-700' : 'text-slate-700'
            }`}
          >
            {REASON_LABELS[item.kind]}
          </span>
          <RepositoryLabel repository={item.repository} short />
          <WorkReference issueNumber={item.issueNumber} prNumber={item.prNumber} />
        </RowMeta>
        <RowTitle>{itemTitle(item)}</RowTitle>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <time dateTime={item.since} title={new Date(item.since).toLocaleString()} className="min-w-0 truncate text-xs text-gray-500">
            Waiting {elapsedLabel(item.since)}
          </time>
          {/*
            Fixed w-20 and centred: every button in the column starts and ends
            on the same two vertical lines whatever its verb.
          */}
          <RowLink
            href={href}
            aria-label={`${actionLabel(item)} ${actionContext(item)}${external ? ' (opens GitHub)' : ''}`}
            className="inline-flex min-h-8 w-20 flex-none items-center justify-center rounded-sm bg-slate-100 px-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
          >
            {actionLabel(item)}
          </RowLink>
        </div>
      </div>
    </li>
  );
};

/**
 * Nothing to do, said quietly — and said across the whole pane.
 *
 * This panel is the top of the right column, and its height is set by the
 * running feed beside it rather than by its own content. One line of text at
 * the top of that pane left a 250px cavern beneath it that read as a failed
 * render, so the line is centred in the space it has to fill instead.
 *
 * A shield rather than a tick: the tone is "nothing is wrong", not "well
 * done". It reports a state; it is not a reward.
 */
const AllClear: React.FC = () => (
  <SectionZeroState
    data-testid="needs-attention-empty"
    icon={<ShieldCheck className="h-6 w-6 text-slate-300" aria-hidden="true" />}
  >
    All tasks operational — no attention required
  </SectionZeroState>
);

export const NeedsAttentionPanel: React.FC<DashboardSectionProps> = ({
  repository,
  refreshToken,
  onLoaded,
}) => {
  const load = useCallback(() => getDashboardAttention(repository), [repository]);
  const { data, error, loading, reload } = useDashboardSection<DashboardAttentionResponse>(
    load,
    repository,
    refreshToken,
    onLoaded,
  );
  // Waiting durations tick without a network read.
  useNowTick();

  const items = data?.items ?? [];
  const unavailable = Boolean(error) && items.length === 0;
  const visible = items.slice(0, VISIBLE_ITEMS);

  /*
    Heading first, always — including while the first read is in flight and
    when it fails. The heading is what holds the top of the right column on
    the same line as the top of the main column, so it cannot be something
    the panel only draws once it has rows.
  */
  return (
    <section
      aria-labelledby="needs-attention-heading"
      data-testid="needs-attention-panel"
      className="flex h-full min-w-0 flex-col bg-white"
    >
      <SectionHeading
        id="needs-attention-heading"
        title="Needs attention"
        count={loading || unavailable ? null : items.length}
      >
        {items.length > 0 && (
          <SectionLink to={filteredTasksHref('attention', repository)}>View all</SectionLink>
        )}
      </SectionHeading>

      {loading && <SectionSkeleton rows={2} />}
      {!loading && unavailable && (
        <SectionError message="Unable to load what needs attention" onRetry={reload} />
      )}
      {!loading && !unavailable && items.length === 0 && <AllClear />}
      {!loading && items.length > 0 && (
        <ul>
          {visible.map(item => (
            <AttentionRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
};

export default NeedsAttentionPanel;
