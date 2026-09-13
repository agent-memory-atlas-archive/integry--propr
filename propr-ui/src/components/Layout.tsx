import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, ScrollText, ListTodo, BookMarked, Bot, Cpu, Settings, ShieldCheck, Inbox, LogOut, Target } from 'lucide-react';
import { logout } from '../api/proprApi';
import { useDynamicFavicon } from '../hooks/useDynamicFavicon';
import { useSystemReadiness } from '../hooks/useSystemReadiness';
import { useToast } from './ui/useToast';
import { MenuIcon, CloseIcon } from './icons/LayoutIcons';
import { DESKTOP_UI_COMMAND_EVENT } from '../desktop/useDesktopNativeCommands';
import GlobalHeader from './GlobalHeader';
import AgentTankSidebar from './AgentTankSidebar';
import { useSocket } from '../contexts/useSocket';
import { useDemoMode } from '../contexts/DemoModeContext';
import { QueueStatsUpdatePayload, IndexingUpdatePayload, DraftUpdatePayload } from '@propr/shared';
import { useCurrentUser, userHasPermission } from '../contexts/AuthContext';
import { ConnectCapacityBanner } from './ConnectPlusBanner';
import { useNotificationCenter } from '../contexts/NotificationCenterContext';
import { publicAssetUrl } from '../config/runtimeMode';
import { DesktopInstanceSelector } from '../desktop/DesktopInstanceSelector';
import { useDesktop } from '../desktop/DesktopContext';
import UserAvatar from './UserAvatar';
import VoiceBriefingControl from './VoiceBriefingControl';

interface LayoutProps {
  children: React.ReactNode;
}

interface NavItem {
  name: string;
  href: string;
  // All nav icons come from lucide so a shared strokeWidth keeps line weights uniform.
  icon: React.FC<{ className?: string; strokeWidth?: number | string }>;
}

// Single badge component for all nav counts: forms a circle for one digit and
// stretches horizontally for wider content (e.g. "99+") with the same radius and padding.
// The parent nav row is `flex items-center justify-between`, which keeps the badge on
// the same horizontal center line as the label.
function NavBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-4 min-w-4 flex-none items-center justify-center rounded-full bg-primary-500 px-1 text-[10px] font-bold leading-none text-white">
      {children}
    </span>
  );
}

function WorkCountBadge({ name, taskCount, goalCount }: { name: string; taskCount: number; goalCount: number }) {
  const count = name === 'Tasks' ? taskCount : name === 'Goals' ? goalCount : 0;
  if (count <= 0) return null;
  return <NavBadge>{count}</NavBadge>;
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();
  const { addToast } = useToast();
  const { isDemoMode } = useDemoMode();
  const { isConnected, subscribeToQueueStats, unsubscribeFromQueueStats, subscribeToIndexingUpdates, unsubscribeFromIndexingUpdates, onQueueStatsUpdate, onIndexingUpdate, onDraftUpdate } = useSocket();
  const [activeQueueCount, setActiveQueueCount] = useState<number>(0);
  const [activeGoalCount, setActiveGoalCount] = useState<number>(0);
  const [generatingPlansCount, setGeneratingPlansCount] = useState<number>(0);
  const user = useCurrentUser();
  const { unreadCount } = useNotificationCenter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const desktop = useDesktop();
  const [desktopSidebarHidden, setDesktopSidebarHidden] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    const handleCommand = (event: Event) => {
      if ((event as CustomEvent).detail === 'toggle-sidebar') {
        if (window.matchMedia('(min-width: 1024px)').matches) setDesktopSidebarHidden(value => !value);
        else setIsSidebarOpen(value => !value);
      }
    };
    window.addEventListener(DESKTOP_UI_COMMAND_EVENT, handleCommand);
    return () => window.removeEventListener(DESKTOP_UI_COMMAND_EVENT, handleCommand);
  }, [desktop]);
  // Track repository indexing statuses for toast notifications
  const repoStatusesRef = useRef<Map<string, string>>(new Map());

  // Keep the favicon's existing aggregate active-work count.
  useDynamicFavicon(activeQueueCount);

  // Track system readiness for proactive sidebar indicators
  const { hasAgents, hasRepos, hasTasks } = useSystemReadiness();

  // The queue's active count aggregates task, plan, and goal jobs. Give each
  // first-class work type its own sidebar count.
  const displayTaskCount = Math.max(0, activeQueueCount - generatingPlansCount - activeGoalCount);

  const navigation: NavItem[] = [
    { name: 'Dashboard', href: '/', icon: LayoutDashboard },
    { name: 'Inbox', href: '/inbox', icon: Inbox },
    { name: 'Plans', href: '/plans', icon: ScrollText },
    { name: 'Goals', href: '/goals', icon: Target },
    { name: 'Tasks', href: '/tasks', icon: ListTodo },
    { name: 'Repositories', href: '/repositories', icon: BookMarked },
    ...(userHasPermission(user, 'instance.manage_agents')
      ? [{ name: 'Coding Agents', href: '/ai-agents', icon: Bot }]
      : []),
    { name: 'LLM Log', href: '/llm-logs', icon: Cpu },
  ];

  const utilityNavigation: NavItem[] = [
    { name: 'Settings', href: '/settings', icon: Settings },
    ...(userHasPermission(user, 'instance.manage_members')
      ? [{ name: 'Access', href: '/admin/members', icon: ShieldCheck }]
      : []),
  ];

  const isActive = (path: string): boolean => {
    const currentPath = location.pathname;

    // Dashboard should only be active on exact match
    if (path === '/') {
      return currentPath === '/';
    }

    // Plans should be active for /plans routes and /studio routes
    if (path === '/plans') {
      return currentPath === '/plans' ||
             currentPath.startsWith('/plans/') ||
             currentPath.startsWith('/studio');
    }

    // Repositories should be active for /repositories routes and /summaries routes (repo content browsing)
    if (path === '/repositories') {
      return currentPath === '/repositories' ||
             currentPath.startsWith('/repositories/') ||
             currentPath.startsWith('/summaries');
    }

    // All other menu items use prefix matching
    return currentPath === path || currentPath.startsWith(path + '/');
  };

  // Close sidebar on route change (mobile)
  useEffect(() => {
    setIsSidebarOpen(false);
  }, [location]);

  // Handle queue stats updates via WebSocket
  const handleQueueStatsUpdate = useCallback((payload: QueueStatsUpdatePayload) => {
    const activeCount = payload.stats.active || 0;
    setActiveQueueCount(activeCount);
    setActiveGoalCount(Math.min(activeCount, Math.max(0, payload.stats.activeGoals || 0)));
  }, []);

  // Handle indexing updates via WebSocket for toast notifications
  const handleIndexingUpdate = useCallback((payload: IndexingUpdatePayload) => {
    const previousStatus = repoStatusesRef.current.get(payload.repository);
    const currentStatus = payload.phase;

    // Show toast when transitioning from 'indexing' to 'failed'
    if (previousStatus === 'indexing' && currentStatus === 'failed') {
      addToast({
        type: 'error',
        message: `Indexing failed for ${payload.repository}`,
      });
    }

    // Update the tracked status
    repoStatusesRef.current.set(payload.repository, currentStatus);
  }, [addToast]);

  // Handle draft updates to track generating plans count
  const handleDraftUpdate = useCallback((payload: DraftUpdatePayload) => {
    // When a draft starts or completes, adjust the count
    // The draft step indicates the phase: 'relevance', 'context', 'llm', etc.
    if (payload.status === 'in_progress' && payload.step === 'relevance') {
      // A new plan generation started
      setGeneratingPlansCount(prev => prev + 1);
    } else if (payload.status === 'completed' || payload.status === 'failed') {
      // A plan generation finished
      setGeneratingPlansCount(prev => Math.max(0, prev - 1));
    }
  }, []);

  // Subscribe to WebSocket events when connected
  useEffect(() => {
    if (!isConnected) return;

    // Subscribe to queue stats and indexing updates
    subscribeToQueueStats();
    subscribeToIndexingUpdates();

    return () => {
      unsubscribeFromQueueStats();
      unsubscribeFromIndexingUpdates();
    };
  }, [isConnected, subscribeToQueueStats, unsubscribeFromQueueStats, subscribeToIndexingUpdates, unsubscribeFromIndexingUpdates]);

  // Register WebSocket event listeners
  useEffect(() => {
    const unsubscribeQueueStats = onQueueStatsUpdate(handleQueueStatsUpdate);
    const unsubscribeIndexing = onIndexingUpdate(handleIndexingUpdate);
    const unsubscribeDraft = onDraftUpdate(handleDraftUpdate);

    return () => {
      unsubscribeQueueStats();
      unsubscribeIndexing();
      unsubscribeDraft();
    };
  }, [onQueueStatsUpdate, onIndexingUpdate, onDraftUpdate, handleQueueStatsUpdate, handleIndexingUpdate, handleDraftUpdate]);

  // Handler for menu toggle
  const handleMenuToggle = () => {
    setDesktopSidebarHidden(false);
    setIsSidebarOpen(true);
  };

  // Active rows pair the teal border / gray background with darker, medium-weight
  // text so the label keeps visual dominance over the low-contrast background.
  const renderNavigationItem = (item: NavItem) => (
    <Link
      key={item.name}
      to={item.href}
      className={`flex items-center justify-between text-[13px] leading-5 transition-colors duration-150 ${
        desktop ? 'mx-2 rounded-lg border-0 px-3 py-1.5' : 'border-l-4 px-4 py-2'
      } ${
        isActive(item.href)
          ? desktop
            ? 'bg-teal-50 font-medium text-teal-700'
            : 'bg-slate-50 font-medium text-slate-900 border-primary-600'
          : desktop
            ? 'font-normal text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            : 'font-normal text-gray-600 hover:bg-gray-50 hover:text-gray-900 border-transparent'
      }`}
    >
      <span className="flex min-w-0 items-center">
        <item.icon className="mr-2.5 h-4 w-4 flex-none" strokeWidth={1.5} />
        <span className="truncate">{item.name}</span>
      </span>
      <WorkCountBadge name={item.name} taskCount={displayTaskCount} goalCount={activeGoalCount} />
      {item.name === 'Inbox' && unreadCount !== null && unreadCount > 0 && (
        <NavBadge>{unreadCount > 99 ? '99+' : unreadCount}</NavBadge>
      )}
      {item.name === 'Tasks' && displayTaskCount === 0 && !hasTasks && hasAgents && hasRepos && (
        <span className="w-2 h-2 flex-none rounded-full bg-amber-500" title="No tasks created yet" />
      )}
      {item.name === 'Plans' && generatingPlansCount > 0 && (
        <NavBadge>{generatingPlansCount}</NavBadge>
      )}
      {item.name === 'Repositories' && !hasRepos && (
        <span className="w-2 h-2 flex-none rounded-full bg-amber-500" title="No repositories configured" />
      )}
      {item.name === 'Coding Agents' && !hasAgents && (
        <span className="w-2 h-2 flex-none rounded-full bg-amber-500" title="No AI agents configured" />
      )}
    </Link>
  );

  return (
    <div className={`${desktop && desktopSidebarHidden ? 'desktop-sidebar-hidden ' : ''}desktop-shell flex h-full min-h-0 flex-col overflow-hidden bg-light-100 relative`}>
      <div className="desktop-shell-content relative flex min-h-0 flex-1 overflow-hidden">
      {desktop && <div className="desktop-connected-drag-region" aria-hidden="true" />}
      {/* Mobile Overlay */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-gray-600 bg-opacity-75 z-20 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar - Responsive */}
      {!(desktop && desktopSidebarHidden) && <aside className={`
        fixed lg:static inset-y-0 left-0 z-30
        desktop-sidebar flex flex-col w-60 bg-white border-r border-gray-200 shadow-sm
        transform transition-transform duration-200 ease-in-out
        ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        <div className="desktop-sidebar-header flex flex-none items-center justify-between px-4 py-4 sm:py-6 h-12 sm:h-16">
          <Link to="/" className="flex items-center" aria-label="ProPR dashboard">
            <img src={publicAssetUrl(desktop ? '/media/logo-and-name-transparent.png' : '/media/logo-and-name.png')} alt="ProPR" className="h-8 w-auto" />
          </Link>
          <button
            onClick={() => setIsSidebarOpen(false)}
            className="lg:hidden text-gray-500 hover:text-gray-700 p-1"
            aria-label="Close menu"
          >
            <CloseIcon className="w-6 h-6" />
          </button>
        </div>
        {desktop && <DesktopInstanceSelector transportReady={isConnected && user !== null} />}
        <div className="flex min-h-0 flex-1 flex-col">
          <nav className="flex min-h-0 flex-col gap-0.5 overflow-y-auto py-1">
            {navigation.map(renderNavigationItem)}
          </nav>
          {/* Usage, settings, metadata, and profile travel together as one utility
              group anchored to the bottom; mt-auto absorbs the flexible space so no
              dividers are needed between the group's members. */}
          <div className="mt-auto flex flex-none flex-col">
          {(isDemoMode || userHasPermission(user, 'instance.manage_agents')) && (
            <AgentTankSidebar allowManualRefresh={!isDemoMode} />
          )}
          <nav className="flex flex-none flex-col gap-0.5 py-1" aria-label="Application settings">
            {utilityNavigation.map(renderNavigationItem)}
          </nav>
          {!desktop && <footer className="px-4 pb-2 pt-1 text-[11px] leading-tight text-gray-400 space-y-1">
            <div>
              <a
                href="https://propr.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-gray-600 hover:underline"
              >
                ProPR
              </a>{' '}
              v{__APP_VERSION__}
            </div>
            <div>© {new Date().getFullYear()} Rinalds Uzkalns</div>
          </footer>}
          {user && (
            // The profile block sits flush under the metadata footer on the web;
            // only the desktop app (which renders no footer) draws a divider.
            <div className={`desktop-sidebar-profile flex flex-none items-center justify-between gap-2 px-3 py-2 ${desktop ? 'border-t border-gray-200' : ''}`}>
              <a
                href={`https://github.com/${user.username}`}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 transition-colors hover:bg-slate-100"
              >
                <UserAvatar
                  user={user}
                  className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-gray-200 object-cover text-[10px] font-bold transition-colors group-hover:border-gray-300"
                  fallbackClassName="bg-primary-100 text-primary-600 group-hover:bg-primary-200"
                />
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-[13px] font-medium text-slate-700">
                    {user.displayName || user.username}
                  </span>
                  <span className="block truncate text-[11px] text-slate-500">@{user.username}</span>
                </span>
              </a>
              <button
                type="button"
                onClick={logout}
                className="flex h-7 w-7 flex-none items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600"
                aria-label="Logout"
                title="Logout"
              >
                <LogOut className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>
          )}
          </div>
        </div>
      </aside>}

      {/* Main content wrapper */}
      <div className="desktop-main-content flex-1 flex flex-col min-w-0">
        {/* GlobalHeader replaces the old inline header */}
        <GlobalHeader
          user={user}
          onLogout={logout}
          onMenuToggle={handleMenuToggle}
          MenuIcon={MenuIcon}
          isDemoMode={isDemoMode}
          inboxUnreadCount={unreadCount}
        />

        {!isDemoMode && <ConnectCapacityBanner />}

        <main className="mobile-content-clearance flex-1 overflow-y-auto md:pb-0">
          {children}
        </main>

        <VoiceBriefingControl />
      </div>
      </div>
    </div>
  );
};

export default Layout;
