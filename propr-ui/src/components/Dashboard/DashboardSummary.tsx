import { useEffect, useState } from 'react';
import { Pause, Play, RefreshCw } from 'lucide-react';
import { useDashboardSummary } from './useDashboardSummary';

// Style recognizable tokens without interpreting generated prose as HTML or Markdown.
const SUMMARY_TOKEN = /(`[^`]+`|\b(?:[\w.-]+\/)?[\w.-]+\s+(?:pull request|PR)\s*#\d+\b|\b(?:[\w.-]+\/)?[\w.-]+#\d+\b|\b(?:[\w@-]+\/)*[\w-]+(?:\.[\w-]+)*\.(?:tsx?|jsx?|mjs|cjs|json|css|scss|html|md|py|rs|go|ya?ml|sql|sh)\b|\b(?:Implementing|Reviewing|Testing|Planning|Refining|Fixing|Building|Deploying|Consolidating|Running tests)\b)/gi;

function SummaryReadout({ summary }: { summary: string }) {
  return summary.split(SUMMARY_TOKEN).map((part, index) => {
    if (index % 2 === 0) return part;
    if (part.includes('#')) {
      const reference = part.replace(/\s+(?:pull request|PR)\s*#/i, '#').replace(/^[\w.-]+\//, '');
      return <code key={index} title={part} className="rounded-sm bg-slate-200/60 px-1 py-0.5 font-mono text-slate-900">{reference}</code>;
    }
    if (part.startsWith('`') || part.includes('.')) {
      return <code key={index} className="font-mono text-slate-700">{part.replace(/^`|`$/g, '')}</code>;
    }
    return <strong key={index} className="font-semibold text-slate-900">{part}</strong>;
  });
}

function Freshness({ updatedAt }: { updatedAt: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  const age = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
  return <span title="Time since the last successful summary update">Updated {age} ago</span>;
}

export function DashboardSummary({ repository, activityToken }: { repository: string; activityToken: number }) {
  const { summary, enabled, loading, paused, updatedAt, available, togglePaused, refresh } = useDashboardSummary(repository, activityToken);
  if (enabled !== true) return null;
  const pauseLabel = paused ? 'Resume automatic summary updates' : 'Pause automatic summary updates';
  const idle = !available || /^No work is (?:active|running)\b/.test(summary ?? '');
  const live = !paused && !idle;
  const status = paused ? 'Paused' : live ? 'Live' : 'Idle';
  const buttonClass = 'flex h-7 w-7 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-200/60 hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <section aria-label="Activity summary" data-testid="dashboard-summary" className="flex h-10 min-w-0 w-full flex-none items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/80 px-3 text-xs sm:gap-4 sm:px-6">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${live ? 'border-teal-200/70 bg-teal-50 text-teal-700' : 'border-slate-200 bg-slate-100 text-slate-500'}`}>
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-teal-500 motion-safe:animate-pulse' : 'border border-slate-400'}`} />
          {status}
        </span>
        <p aria-live="polite" aria-busy={loading} title={summary ?? 'Summary unavailable'} className="min-w-0 truncate text-slate-700">
          {summary ? <SummaryReadout summary={summary} /> : 'Summary unavailable'}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-3">
        <span className="whitespace-nowrap font-mono text-[11px] text-slate-400">
          {loading ? 'Updating…' : updatedAt !== null ? <Freshness updatedAt={updatedAt} /> : 'Awaiting data'}
        </span>
        <span aria-hidden="true" className="hidden h-3 w-px bg-slate-200 sm:block" />
        <div className="flex items-center gap-1">
          <button type="button" aria-label={pauseLabel} title={pauseLabel} aria-pressed={paused} onClick={togglePaused} className={buttonClass}>
            {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
          </button>
          <button type="button" aria-label="Refresh activity summary" title="Refresh activity summary" onClick={refresh} disabled={loading} className={buttonClass}>
            <RefreshCw size={14} aria-hidden="true" className={loading ? 'motion-safe:animate-spin' : undefined} />
          </button>
        </div>
      </div>
    </section>
  );
}
