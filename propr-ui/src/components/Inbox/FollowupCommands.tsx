import React, { useEffect, useRef, useState } from 'react';
import { Check, Loader2, MoreHorizontal, Terminal } from 'lucide-react';
import { postTaskFollowup } from '../../api/proprApi';
import { useToast } from '../ui/useToast';
import { claimFollowup, settleFollowup, useFollowupSubmission } from './followupSubmissions';

export interface FollowupCommandsProps {
  /** The run the commands are sent through; its pull request receives them. */
  taskId: string;
  prNumber: number;
  /** The primary command first. */
  commands: readonly string[];
  /** Names the group for assistive tech. */
  label: string;
  onCommandSent?: () => Promise<void> | void;
  className?: string;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The follow-up commands for one run's pull request. A command in flight or
 * already sent is shared by every card showing the run, so neither a second
 * card nor a remount can send it twice.
 */
export const FollowupCommands: React.FC<FollowupCommandsProps> = ({
  taskId,
  prNumber,
  commands,
  label,
  onCommandSent,
  className = '',
}) => {
  const { addToast } = useToast();
  const submission = useFollowupSubmission(taskId);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  if (commands.length === 0) return null;

  const send = async (command: string) => {
    if (!claimFollowup(taskId, command)) return;
    try {
      await postTaskFollowup(taskId, command, 'pull_request');
    } catch (error) {
      settleFollowup(taskId, false);
      addToast({
        type: 'error',
        message: `Couldn't send ${command} to PR #${prNumber}. ${errorMessage(error, 'Please try again.')}`,
      });
      return;
    }
    settleFollowup(taskId, true);
    addToast({ type: 'success', message: `Sent ${command} to PR #${prNumber}.` });
    await onCommandSent?.();
  };

  const pendingCommand = submission?.status === 'pending' ? submission.command : null;
  const sentCommand = submission?.status === 'sent' ? submission.command : null;
  const [primary, ...secondary] = commands;
  const commandIcon = (command: string) => {
    if (pendingCommand === command) return <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />;
    if (sentCommand === command) return <Check className="h-3.5 w-3.5" aria-hidden="true" />;
    return <Terminal className="h-3.5 w-3.5" aria-hidden="true" />;
  };
  const buttonClass = 'items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white font-mono text-xs font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-7 sm:gap-1 sm:px-2';
  const disabled = submission !== undefined;

  // Phones show the primary command and tuck the rest behind a menu, so the commands keep one line.
  return (
    <div className={`flex min-w-0 items-center gap-2 ${className}`} role="group" aria-label={label}>
      {commands.map(command => (
        <button
          key={command}
          type="button"
          disabled={disabled}
          onClick={() => void send(command)}
          className={`${command === primary ? 'inline-flex' : 'hidden sm:inline-flex'} min-h-10 px-3 ${buttonClass}`}
          aria-label={`Send ${command} to PR #${prNumber}`}
          title={sentCommand === command ? `${command} was sent to PR #${prNumber}` : undefined}
        >
          {commandIcon(command)}
          {command}
        </button>
      ))}
      {secondary.length > 0 && (
        <div ref={menuRef} className="relative sm:hidden">
          <button
            type="button"
            disabled={disabled}
            onClick={() => setMenuOpen(open => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`More commands for PR #${prNumber}`}
            className={`inline-flex h-10 w-10 ${buttonClass}`}
          >
            {pendingCommand && secondary.includes(pendingCommand)
              ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              : <MoreHorizontal className="h-4 w-4" aria-hidden="true" />}
          </button>
          {menuOpen && (
            <div role="menu" className="absolute bottom-full right-0 z-20 mb-1 min-w-[10rem] overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg">
              {secondary.map(command => (
                <button
                  key={command}
                  type="button"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); void send(command); }}
                  className="flex min-h-10 w-full items-center gap-2 px-3 text-left font-mono text-xs font-semibold text-slate-700 hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
                  aria-label={`Send ${command} to PR #${prNumber}`}
                >
                  <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                  {command}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default FollowupCommands;
