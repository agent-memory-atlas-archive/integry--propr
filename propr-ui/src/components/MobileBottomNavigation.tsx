import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  BookMarked,
  Bot,
  ChartColumn,
  ChevronRight,
  CircleCheck,
  CircleAlert,
  Cpu,
  Inbox,
  LayoutDashboard,
  ListTodo,
  LogOut,
  MoreHorizontal,
  Plug,
  Plus,
  ScrollText,
  Settings,
  Target,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { HeaderStats } from '../hooks/useHeaderStats';
import type { CurrentUser } from '../api/proprTypes';
import { userHasPermission } from '../contexts/AuthContext';
import AgentTankSidebar from './AgentTankSidebar';
import UserAvatar from './UserAvatar';
import QuickAddTodo from './QuickAddTodo';
import { creationActions } from './creationActions';
import BottomSheet from './MobileBottomSheet';

interface MobileBottomNavigationProps {
  user: CurrentUser | null;
  onLogout: () => void;
  isDemoMode: boolean;
  unreadCount: number | null;
  systemHealth: HeaderStats['systemHealth'];
}

type SheetId = 'create' | 'more';

const pathMatches = (pathname: string, path: string): boolean =>
  pathname === path || pathname.startsWith(`${path}/`);

// The Create sheet lists the work an engineer starts most often first.
const CREATE_ORDER = ['task', 'goal', 'plan', 'automation'] as const;
const createItems = CREATE_ORDER.map(id => creationActions.find(action => action.id === id)!);

const getNavigationState = (pathname: string, search: string) => {
  const creating = createItems.some(action => `${pathname}${search}` === action.to);
  return {
    dashboard: pathname === '/',
    tasks: pathMatches(pathname, '/tasks') && pathname !== '/tasks/new',
    creating,
    inbox: pathMatches(pathname, '/inbox'),
    more: !creating && (
      pathMatches(pathname, '/goals') || pathMatches(pathname, '/plans') ||
      (pathMatches(pathname, '/studio') && pathname !== '/studio/new') ||
      (pathMatches(pathname, '/automations') && pathname !== '/automations/new') ||
      pathMatches(pathname, '/repositories') || pathMatches(pathname, '/summaries') ||
      pathMatches(pathname, '/analytics') || pathMatches(pathname, '/llm-logs') ||
      pathMatches(pathname, '/mcp-logs') || pathMatches(pathname, '/ai-agents') ||
      pathMatches(pathname, '/settings') || pathMatches(pathname, '/admin/members')
    ),
  };
};

interface MoreItem {
  label: string;
  to: string;
  icon: LucideIcon;
}

// Destinations only: creation lives behind the Create tab. Names and gates
// mirror the desktop sidebar so a page is called the same thing everywhere.
const getMoreGroups = (user: CurrentUser | null) => ({
  workspace: [
    { label: 'Goals', to: '/goals', icon: Target },
    { label: 'Plans', to: '/plans', icon: ScrollText },
    { label: 'Automations', to: '/automations', icon: Workflow },
    { label: 'Repositories', to: '/repositories', icon: BookMarked },
  ] as MoreItem[],
  telemetry: [
    { label: 'Analytics', to: '/analytics', icon: ChartColumn },
    { label: 'LLM Log', to: '/llm-logs', icon: Cpu },
    ...(userHasPermission(user, 'instance.manage_settings')
      ? [{ label: 'MCP Log', to: '/mcp-logs', icon: Plug }]
      : []),
  ] as MoreItem[],
  configuration: [
    ...(userHasPermission(user, 'instance.manage_agents')
      ? [{ label: 'Coding Agents', to: '/ai-agents', icon: Bot }]
      : []),
    { label: 'Settings', to: '/settings', icon: Settings },
    ...(userHasPermission(user, 'instance.manage_members')
      ? [{ label: 'Access', to: '/admin/members', icon: ShieldCheck }]
      : []),
  ] as MoreItem[],
});

interface MobileNavLinkProps {
  to: string;
  label: string;
  active: boolean;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  accessibleLabel?: string;
  onClick?: () => void;
}

const MobileNavLink: React.FC<MobileNavLinkProps> = ({
  to,
  label,
  active,
  icon,
  badge,
  accessibleLabel,
  onClick,
}) => (
  <Link
    to={to}
    onClick={onClick}
    aria-label={accessibleLabel}
    aria-current={active ? 'page' : undefined}
    className={`relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 ${
      active ? 'text-primary-700' : 'text-slate-500 hover:text-slate-800'
    }`}
  >
    {/*
      A fixed icon slot, the height of the Create button's pill. Without one
      the icon-only items were 20px tall and the pill 32px, so every label on
      the bar sat on a different baseline from its neighbour's.
    */}
    <span className="relative flex h-8 w-9 items-center justify-center">
      {icon}
      {badge}
    </span>
    <span className="max-w-full truncate">{label}</span>
  </Link>
);

const listRowClassName = 'flex min-h-12 items-center gap-3 px-4 py-3 text-sm text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500';

const ListSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => {
  const id = `mobile-more-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="border-t border-slate-100 first:border-t-0">
      <h3 id={id} className="px-4 pb-1 pt-4 text-[11px] font-bold uppercase tracking-wider text-slate-400">
        {title}
      </h3>
      <ul className="divide-y divide-slate-100">{children}</ul>
    </section>
  );
};

const MoreLink: React.FC<{ item: MoreItem; onNavigate: () => void }> = ({ item, onNavigate }) => (
  <li>
    <Link to={item.to} onClick={onNavigate} className={listRowClassName}>
      <item.icon className="h-5 w-5 flex-none text-slate-500" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
      <ChevronRight className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
    </Link>
  </li>
);

const HealthDetails: React.FC<{ systemHealth: HeaderStats['systemHealth'] }> = ({ systemHealth }) => {
  const rows = [
    ['Daemon', systemHealth.daemon],
    ['Workers', systemHealth.workers],
    ['Redis', systemHealth.redis],
    ['GitHub', systemHealth.githubAuth],
    ['Indexing', systemHealth.indexing],
  ];

  return (
    <details className="group">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 [&::-webkit-details-marker]:hidden">
        {systemHealth.isHealthy ? (
          <CircleCheck className="h-5 w-5 flex-none text-green-600" aria-hidden="true" />
        ) : (
          <CircleAlert className="h-5 w-5 flex-none text-amber-600" aria-hidden="true" />
        )}
        <span className="font-medium">System health</span>
        <span className={`ml-auto text-xs font-medium ${systemHealth.isHealthy ? 'text-green-700' : 'text-amber-700'}`}>
          {systemHealth.isHealthy ? 'Healthy' : 'Needs attention'}
        </span>
        <ChevronRight className="h-4 w-4 flex-none text-slate-400 transition-transform group-open:rotate-90" aria-hidden="true" />
      </summary>
      <div className="space-y-2 bg-slate-50 px-4 py-3">
        {rows.map(([label, status]) => (
          <div key={label} className="flex items-center justify-between gap-4 text-xs">
            <span className="text-slate-500">{label}</span>
            <span className="font-medium text-slate-700">{status}</span>
          </div>
        ))}
      </div>
    </details>
  );
};

const MobileBottomNavigation: React.FC<MobileBottomNavigationProps> = ({
  user,
  onLogout,
  isDemoMode,
  unreadCount,
  systemHealth,
}) => {
  const location = useLocation();
  const [openSheet, setOpenSheet] = useState<SheetId | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  const closeCreate = useCallback(() => {
    setOpenSheet(null);
    createButtonRef.current?.focus();
  }, []);
  const closeMore = useCallback(() => {
    setOpenSheet(null);
    moreButtonRef.current?.focus();
  }, []);
  // Following a link closes the sheet without pulling focus back to the bar.
  const closeForNavigation = () => setOpenSheet(null);
  const toggleSheet = (sheet: SheetId) => setOpenSheet(current => (current === sheet ? null : sheet));

  useEffect(() => {
    setOpenSheet(null);
  }, [location.pathname, location.search, location.hash]);

  const active = getNavigationState(location.pathname, location.search);
  const groups = getMoreGroups(user);
  const showUsage = isDemoMode || userHasPermission(user, 'instance.manage_agents');

  const unreadBadge = unreadCount !== null && unreadCount > 0 ? (
    <span className="absolute right-0 top-0 inline-flex min-w-4 items-center justify-center rounded-full bg-primary-500 px-1 text-[9px] font-bold leading-4 text-white">
      {unreadCount > 99 ? '99+' : unreadCount}
    </span>
  ) : undefined;

  return (
    <>
      {openSheet === 'create' && (
        <BottomSheet id="mobile-create-sheet" title="Create" closeLabel="Close Create menu" onClose={closeCreate}>
          <nav aria-label="Create">
            <ul className="divide-y divide-slate-100">
              {createItems.map(action => (
                <li key={action.id}>
                  <Link to={action.to} onClick={closeForNavigation} className={listRowClassName}>
                    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-primary-50 text-primary-700">
                      <action.icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{action.label}</span>
                    <ChevronRight className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="border-t border-slate-100 p-3">
            <QuickAddTodo layout="inline" disabled={isDemoMode} />
          </div>
        </BottomSheet>
      )}

      {openSheet === 'more' && (
        <BottomSheet id="mobile-more-sheet" title="More" closeLabel="Close More menu" onClose={closeMore}>
          {user && (
            <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
              <UserAvatar
                user={user}
                className="flex h-10 w-10 flex-none items-center justify-center rounded-full border border-slate-200 object-cover text-xs font-bold"
                fallbackClassName="bg-primary-100 text-primary-700"
                decorative
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-800">{user.displayName || user.username}</p>
                <p className="truncate text-xs text-slate-500">@{user.username}</p>
              </div>
              <button
                type="button"
                onClick={onLogout}
                className="inline-flex min-h-10 flex-none items-center gap-2 rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                Sign out
              </button>
            </div>
          )}

          <nav aria-label="More navigation">
            <ListSection title="Workspace">
              {groups.workspace.map(item => <MoreLink key={item.to} item={item} onNavigate={closeForNavigation} />)}
            </ListSection>
            <ListSection title="Telemetry & system">
              {groups.telemetry.map(item => <MoreLink key={item.to} item={item} onNavigate={closeForNavigation} />)}
              <li><HealthDetails systemHealth={systemHealth} /></li>
              {showUsage && (
                <li className="empty:hidden">
                  <AgentTankSidebar allowManualRefresh={!isDemoMode} layout="disclosure" />
                </li>
              )}
            </ListSection>
            <ListSection title="Configuration">
              {groups.configuration.map(item => <MoreLink key={item.to} item={item} onNavigate={closeForNavigation} />)}
            </ListSection>
          </nav>
        </BottomSheet>
      )}

      <nav
        aria-label="Primary navigation"
        className="mobile-bottom-navigation fixed inset-x-0 bottom-0 z-40 flex h-[calc(4rem+env(safe-area-inset-bottom))] border-t border-slate-200 bg-white/95 shadow-[0_-4px_16px_rgba(15,23,42,0.08)] backdrop-blur md:hidden"
      >
        <MobileNavLink
          to="/"
          label="Dashboard"
          active={active.dashboard}
          icon={<LayoutDashboard className="h-5 w-5" aria-hidden="true" />}
        />
        {/* Tasks and their agents' progress are what a phone is checked for;
            Repositories, a configuration page, moved into More. */}
        <MobileNavLink
          to="/tasks"
          label="Tasks"
          active={active.tasks}
          icon={<ListTodo className="h-5 w-5" aria-hidden="true" />}
        />
        <button
          ref={createButtonRef}
          type="button"
          onClick={() => toggleSheet('create')}
          disabled={isDemoMode}
          aria-haspopup="dialog"
          aria-expanded={openSheet === 'create'}
          aria-controls="mobile-create-sheet"
          aria-current={active.creating ? 'page' : undefined}
          aria-label={isDemoMode ? 'Create unavailable in demo mode' : 'Create'}
          className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 disabled:text-slate-400 ${
            active.creating || openSheet === 'create' ? 'text-primary-800' : 'text-primary-700'
          }`}
        >
          <span className={`flex h-8 w-9 items-center justify-center rounded-lg ${isDemoMode ? 'bg-slate-200' : 'bg-primary-600 text-white shadow-sm'}`}>
            <Plus className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="max-w-full truncate">Create</span>
        </button>
        <MobileNavLink
          to="/inbox"
          label="Inbox"
          active={active.inbox}
          accessibleLabel={unreadCount !== null && unreadCount > 0
            ? `Inbox, ${unreadCount} unread notifications`
            : 'Inbox'}
          icon={<Inbox className="h-5 w-5" aria-hidden="true" />}
          badge={unreadBadge}
        />
        <button
          ref={moreButtonRef}
          type="button"
          onClick={() => toggleSheet('more')}
          aria-haspopup="dialog"
          aria-expanded={openSheet === 'more'}
          aria-controls="mobile-more-sheet"
          aria-current={active.more ? 'page' : undefined}
          className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 ${
            active.more || openSheet === 'more' ? 'text-primary-700' : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          <span className="flex h-8 w-9 items-center justify-center">
            <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
          </span>
          <span>More</span>
        </button>
      </nav>
    </>
  );
};

export default MobileBottomNavigation;
