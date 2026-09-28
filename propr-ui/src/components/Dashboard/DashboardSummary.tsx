import { Pause, Play, RefreshCw } from 'lucide-react';
import { useDashboardSummary } from './useDashboardSummary';

export function DashboardSummary({ repository, activityToken }: { repository: string; activityToken: number }) {
  const { summary, enabled, loading, paused, togglePaused, refresh } = useDashboardSummary(repository, activityToken);
  if (enabled !== true) return null;
  const pauseLabel = paused ? 'Resume automatic summary updates' : 'Pause automatic summary updates';
  const buttonClass = 'flex h-8 w-8 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-40';
  return (
    <section aria-label="Activity summary" data-testid="dashboard-summary" className="flex min-w-0 flex-none items-start gap-2 border-b border-slate-200 px-3 py-3 sm:px-6">
      <p aria-live="polite" aria-busy={loading} className="min-w-0 flex-1 break-words text-sm leading-6 text-slate-600">
        {summary ?? 'Summary unavailable'}
      </p>
      <div className="flex shrink-0 items-center">
        <button type="button" aria-label={pauseLabel} title={pauseLabel} aria-pressed={paused} onClick={togglePaused} className={buttonClass}>
          {paused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
        </button>
        <button type="button" aria-label="Refresh activity summary" title="Refresh activity summary" onClick={refresh} disabled={loading} className={buttonClass}>
          <RefreshCw size={15} aria-hidden="true" className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>
    </section>
  );
}
