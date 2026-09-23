import React from 'react';
import { RepositoryIcon } from '../RepositoryIcon';

interface RepositoryChipProps {
  repository: string;
  /** Repository-relative path to a custom icon; the chip shows no icon at all when absent. */
  iconPath?: string | null;
  revision?: string | null;
  className?: string;
  title?: string;
}

/**
 * Shared monospace code chip for a repository identity: `owner/name`, preceded by the repository's
 * own icon when it has one. Repositories without a fetched icon render no mark rather than a wall of
 * repeated GitHub logos. The chip is inline so the background hugs the text instead of stretching
 * across its column; long names truncate inside it and stay reachable through the tooltip.
 */
export const RepositoryChip: React.FC<RepositoryChipProps> = ({
  repository,
  iconPath,
  revision,
  className = '',
  title,
}) => (
  <span
    data-testid="repository-chip"
    className={`inline-flex max-w-full items-center gap-1.5 align-middle rounded-sm border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-[12px] leading-4 text-slate-800 ${className}`.trim()}
    title={title ?? repository}
  >
    <RepositoryIcon
      repository={repository}
      iconPath={iconPath}
      revision={revision}
      className="h-3.5 w-3.5"
      fallback="none"
    />
    <span className="truncate font-mono">{repository}</span>
  </span>
);
