import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  Bot,
  GitPullRequest,
  type LucideIcon,
  Plug,
  RefreshCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  X
} from 'lucide-react';

export type SettingsCategoryId =
  | 'general'
  | 'models'
  | 'workflow'
  | 'ultrafix'
  | 'sandbox'
  | 'integrations'
  | 'notifications';

interface SettingsCategory {
  id: SettingsCategoryId;
  label: string;
  description: string;
  icon: LucideIcon;
}

// eslint-disable-next-line react-refresh/only-export-components
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Application preferences for this workspace.',
    icon: SlidersHorizontal
  },
  {
    id: 'models',
    label: 'AI Models & Reasoning',
    description: 'Choose models and configure the repository knowledge base.',
    icon: Bot
  },
  {
    id: 'workflow',
    label: 'Workflow & PR Rules',
    description: 'Processing rules, GitHub triggers, and assignment gates.',
    icon: GitPullRequest
  },
  {
    id: 'ultrafix',
    label: 'Ultrafix & Escalation',
    description: 'Fix-and-review loops, model escalation, and agent watchdogs.',
    icon: RefreshCcw
  },
  {
    id: 'sandbox',
    label: 'Sandbox & Network',
    description: 'Outbound network access for agent containers.',
    icon: ShieldCheck
  },
  {
    id: 'integrations',
    label: 'Integrations & MCP',
    description: 'Connect supporting services and customize agent runtimes.',
    icon: Plug
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Choose which updates reach your inbox and browser.',
    icon: Bell
  }
];

export const DEFAULT_SETTINGS_CATEGORY: SettingsCategoryId = 'general';

export interface SettingsNavigationSection {
  id: string;
  category: SettingsCategoryId;
  searchText: string;
  content: React.ReactNode;
}

interface SettingsNavigationProps {
  sections: SettingsNavigationSection[];
  isReadOnly?: boolean;
  activeCategory?: SettingsCategoryId;
  onActiveCategoryChange?(category: SettingsCategoryId): void;
}

// eslint-disable-next-line react-refresh/only-export-components
export function matchesSettingsSearch(section: SettingsNavigationSection, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const searchableText = `${section.id} ${section.searchText}`.toLocaleLowerCase();
  return terms.every(term => searchableText.includes(term));
}

const NEXT_TAB_KEYS: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

/**
 * Settings as a split-pane console: a vertical category rail on the left and a
 * reading pane held to `max-w-2xl` on the right. The selected rail item names
 * the open category, so the pane carries no second heading for it. On narrow
 * screens the rail folds into a horizontally scrolling strip above the pane.
 */
const SettingsNavigation: React.FC<SettingsNavigationProps> = ({
  sections,
  isReadOnly = false,
  activeCategory: controlledActiveCategory,
  onActiveCategoryChange,
}) => {
  const [localActiveCategory, setLocalActiveCategory] = useState<SettingsCategoryId>(DEFAULT_SETTINGS_CATEGORY);
  const [query, setQuery] = useState('');
  const tabRefs = useRef<Partial<Record<SettingsCategoryId, HTMLButtonElement | null>>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeCategory = controlledActiveCategory ?? localActiveCategory;
  const normalizedQuery = query.trim();

  // A newly opened category starts at its top, and on narrow screens, where the
  // rail scrolls sideways, its rail item stays in view.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    tabRefs.current[activeCategory]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeCategory]);

  const selectCategory = (category: SettingsCategoryId): void => {
    setLocalActiveCategory(category);
    onActiveCategoryChange?.(category);
    setQuery('');
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | null = null;
    if (event.key in NEXT_TAB_KEYS) {
      nextIndex = (index + NEXT_TAB_KEYS[event.key] + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = SETTINGS_CATEGORIES.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const next = SETTINGS_CATEGORIES[nextIndex].id;
    selectCategory(next);
    tabRefs.current[next]?.focus();
  };

  const matchedSectionIds = useMemo(
    () => new Set(sections.filter(section => matchesSettingsSearch(section, normalizedQuery)).map(section => section.id)),
    [normalizedQuery, sections]
  );

  const searchResultCount = normalizedQuery ? matchedSectionIds.size : 0;

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-white" data-settings-scroll>
      <div className="mx-auto flex w-full max-w-5xl flex-col md:flex-row md:items-start md:gap-10 md:px-4">
        <nav
          aria-label="Settings"
          data-settings-rail
          className="sticky top-0 z-10 flex flex-shrink-0 flex-col gap-3 border-b border-slate-200 bg-white px-4 pb-3 pt-2 md:w-56 md:border-b-0 md:px-0 md:pb-8 md:pt-2"
        >
          <div className="relative">
            <label htmlFor="settings-search" className="sr-only">Search settings</label>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            />
            <input
              id="settings-search"
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search settings..."
              className="h-9 w-full rounded border border-slate-300 bg-slate-50 pl-9 pr-9 text-sm text-slate-900 placeholder:text-slate-400 focus:border-primary-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear settings search"
                className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700"
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div
            className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:flex-col md:overflow-visible md:px-0"
            role="tablist"
            aria-label="Settings categories"
            aria-orientation="vertical"
          >
            {SETTINGS_CATEGORIES.map((category, index) => {
              const selected = activeCategory === category.id;
              const Icon = category.icon;
              return (
                <button
                  key={category.id}
                  ref={element => { tabRefs.current[category.id] = element; }}
                  id={`settings-tab-${category.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`settings-panel-${category.id}`}
                  tabIndex={selected ? 0 : -1}
                  title={category.description}
                  onClick={() => selectCategory(category.id)}
                  onKeyDown={event => handleTabKeyDown(event, index)}
                  className={`inline-flex flex-shrink-0 items-center gap-2 whitespace-nowrap rounded px-2.5 py-1.5 text-left text-[13px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 md:w-full ${
                    selected
                      ? 'bg-teal-50 font-semibold text-teal-700'
                      : 'font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  <Icon aria-hidden="true" className={`h-4 w-4 flex-shrink-0 ${selected ? 'text-teal-600' : 'text-slate-400'}`} />
                  {category.label}
                </button>
              );
            })}
          </div>

          <p className="sr-only" aria-live="polite">
            {normalizedQuery
              ? `${searchResultCount} settings ${searchResultCount === 1 ? 'section' : 'sections'} found.`
              : `${SETTINGS_CATEGORIES.find(category => category.id === activeCategory)?.label} settings selected.`}
          </p>
        </nav>

        <div className="min-w-0 max-w-2xl flex-1 px-4 pb-16 pt-6 md:px-0 md:pt-2" data-settings-pane>
          {normalizedQuery && (
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Search results</h3>
                <p className="mt-0.5 text-[12px] text-slate-500">
                  {searchResultCount} {searchResultCount === 1 ? 'section' : 'sections'} matching “{normalizedQuery}”
                </p>
              </div>
            </div>
          )}

          {SETTINGS_CATEGORIES.map(category => {
            const categorySections = sections.filter(section => section.category === category.id);
            const visibleSections = normalizedQuery
              ? categorySections.filter(section => matchedSectionIds.has(section.id))
              : categorySections;
            const categoryIsVisible = normalizedQuery
              ? visibleSections.length > 0
              : activeCategory === category.id;

            return (
              <section
                key={category.id}
                id={`settings-panel-${category.id}`}
                role={normalizedQuery ? 'region' : 'tabpanel'}
                aria-labelledby={`settings-tab-${category.id}`}
                hidden={!categoryIsVisible}
                className={normalizedQuery ? 'mb-12' : undefined}
              >
                {/* Search results mix categories, so only they name the category a match came from. */}
                {normalizedQuery && (
                  <h3 className="mb-6 text-sm font-semibold text-slate-900">{category.label}</h3>
                )}

                <div className="space-y-10">
                  {categorySections.map(section => (
                    <div
                      key={section.id}
                      hidden={normalizedQuery ? !matchedSectionIds.has(section.id) : false}
                      data-settings-section={section.id}
                    >
                      <fieldset disabled={isReadOnly} className={isReadOnly ? 'opacity-70' : ''}>
                        {section.content}
                      </fieldset>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}

          {normalizedQuery && searchResultCount === 0 && (
            <div className="border-t border-slate-200 px-6 py-12 text-center">
              <Search aria-hidden="true" className="mx-auto h-6 w-6 text-slate-300" />
              <h3 className="mt-3 text-sm font-medium text-slate-900">No settings found</h3>
              <p className="mt-1 text-[12px] text-slate-500">Try a different keyword or clear the search.</p>
              <button
                type="button"
                onClick={() => setQuery('')}
                className="mt-4 rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Clear search
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SettingsNavigation;
