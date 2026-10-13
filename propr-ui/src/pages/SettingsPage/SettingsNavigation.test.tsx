import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import SettingsNavigation, {
  matchesSettingsSearch,
  type SettingsNavigationSection
} from './SettingsNavigation';
import { useSettingsCategoryRoute } from './useSettingsCategoryRoute';

const sections: SettingsNavigationSection[] = [
  {
    id: 'model-selection',
    category: 'models',
    searchText: 'implementation model reasoning',
    content: <p>Model controls</p>
  },
  {
    id: 'merge-rules',
    category: 'workflow',
    searchText: 'automatically resolve merge conflicts',
    content: <p>Merge controls</p>
  },
  {
    id: 'agent-network',
    category: 'sandbox',
    searchText: 'egress proxy allowed hosts',
    content: <p>Network controls</p>
  },
  {
    id: 'usage-tips',
    category: 'general',
    searchText: 'usage tips documentation',
    content: <p>Tip controls</p>
  },
  {
    id: 'visual-previews',
    category: 'integrations',
    searchText: 'GitHub screenshot upload token',
    content: <p>Preview controls</p>
  },
  {
    id: 'personal-notifications',
    category: 'notifications',
    searchText: 'browser push inbox quiet hours timezone',
    content: <p>Notification controls</p>
  }
];

const RoutedSettingsNavigation = () => {
  const categoryRoute = useSettingsCategoryRoute();
  const location = useLocation();
  const navigate = useNavigate();
  return <>
    <button type="button" onClick={() => navigate('/settings?flow=desktop&tab=notifications')}>
      Open notification settings
    </button>
    <output data-testid="settings-location">{location.search}</output>
    <SettingsNavigation sections={sections} {...categoryRoute} />
  </>;
};

describe('SettingsNavigation', () => {
  test('lists the settings domains in a vertical rail beside a constrained reading pane', () => {
    const { container } = render(<SettingsNavigation sections={sections} />);

    const rail = screen.getByRole('tablist', { name: 'Settings categories' });
    expect(rail).toHaveAttribute('aria-orientation', 'vertical');
    expect(rail).toHaveClass('md:flex-col');
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'General',
      'AI Models & Reasoning',
      'Workflow & PR Rules',
      'Ultrafix & Escalation',
      'Sandbox & Network',
      'Integrations & MCP',
      'Notifications',
    ]);
    // Rail items carry no count pill: a number beside an item reads as an alert.
    for (const tab of screen.getAllByRole('tab')) expect(tab.textContent).not.toMatch(/\d/);

    const generalTab = screen.getByRole('tab', { name: 'General' });
    expect(generalTab).toHaveAttribute('aria-selected', 'true');
    expect(generalTab).toHaveClass('bg-teal-50', 'text-teal-700');
    expect(screen.getByText('Tip controls')).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Settings' })).toContainElement(
      screen.getByRole('searchbox', { name: 'Search settings' })
    );

    // The reading pane is held to max-w-2xl and blocks stay flat — no card.
    const pane = container.querySelector('[data-settings-pane]');
    expect(pane).toHaveClass('max-w-2xl');
    expect(container.querySelector('[data-settings-section="usage-tips"]')?.parentElement).toHaveClass('space-y-10');
    expect(container.querySelector('[data-settings-section="usage-tips"]')).not.toHaveClass('rounded-lg', 'border', 'shadow-sm');

    // The rail names the open domain, so the pane does not repeat it as a heading.
    expect(screen.queryByRole('heading', { name: 'General' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox & Network' }));
    expect(screen.getByRole('tab', { name: 'Sandbox & Network' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Network controls')).toBeVisible();
    expect(screen.getByText('Tip controls')).not.toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Sandbox & Network' })).toBeNull();
  });

  test('moves between rail items with the arrow keys', () => {
    render(<SettingsNavigation sections={sections} />);
    const general = screen.getByRole('tab', { name: 'General' });
    general.focus();

    fireEvent.keyDown(general, { key: 'ArrowDown' });
    expect(screen.getByRole('tab', { name: 'AI Models & Reasoning' })).toHaveFocus();
    expect(screen.getByText('Model controls')).toBeVisible();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'AI Models & Reasoning' }), { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Notifications' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Notifications' }), { key: 'ArrowDown' });
    expect(screen.getByRole('tab', { name: 'General' })).toHaveFocus();
  });

  test('selects a routed category and reports tab changes to routing state', () => {
    const onActiveCategoryChange = vi.fn();
    const view = render(
      <SettingsNavigation
        sections={sections}
        activeCategory="notifications"
        onActiveCategoryChange={onActiveCategoryChange}
      />
    );

    expect(screen.getByRole('tab', { name: /Notifications/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Notification controls')).toBeVisible();

    view.rerender(
      <SettingsNavigation
        sections={sections}
        activeCategory="workflow"
        onActiveCategoryChange={onActiveCategoryChange}
      />
    );
    expect(screen.getByText('Merge controls')).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: /Notifications/ }));
    expect(onActiveCategoryChange).toHaveBeenCalledWith('notifications');
  });

  test('opens the old Automation tab links on Workflow & PR Rules', () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=automation']}>
        <RoutedSettingsNavigation />
      </MemoryRouter>
    );
    expect(screen.getByRole('tab', { name: 'Workflow & PR Rules' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Merge controls')).toBeVisible();
  });

  test('reacts to a notification route while another settings tab is open', () => {
    render(
      <MemoryRouter initialEntries={['/settings?flow=desktop&tab=automation']}>
        <RoutedSettingsNavigation />
      </MemoryRouter>
    );
    expect(screen.getByText('Merge controls')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Open notification settings' }));
    expect(screen.getByRole('tab', { name: /Notifications/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Notification controls')).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox & Network' }));
    expect(screen.getByTestId('settings-location')).toHaveTextContent('?flow=desktop&tab=sandbox');

    fireEvent.click(screen.getByRole('tab', { name: 'General' }));
    expect(screen.getByTestId('settings-location')).toHaveTextContent('?flow=desktop');
    expect(screen.getByTestId('settings-location')).not.toHaveTextContent('tab=');
  });

  test('searches every category and restores the selected tab when cleared', () => {
    render(<SettingsNavigation sections={sections} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Workflow & PR Rules' }));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), {
      target: { value: 'quiet hours' }
    });

    expect(screen.getByText('Notification controls')).toBeVisible();
    expect(screen.getByText('Merge controls')).not.toBeVisible();
    expect(screen.getByText(/1 section matching “quiet hours”/)).toBeVisible();
    // Results mix categories, so each group names where its match lives.
    expect(screen.getByRole('heading', { name: 'Notifications' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Clear settings search' }));

    expect(screen.getByText('Merge controls')).toBeVisible();
    expect(screen.getByText('Notification controls')).not.toBeVisible();
  });

  test('shows an actionable empty state for unmatched keywords', () => {
    render(<SettingsNavigation sections={sections} />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), {
      target: { value: 'does-not-exist' }
    });

    expect(screen.getByText('No settings found')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByText('Tip controls')).toBeVisible();
  });

  test('matches every word case-insensitively', () => {
    expect(matchesSettingsSearch(sections[1], 'MERGE conflicts')).toBe(true);
    expect(matchesSettingsSearch(sections[1], 'merge notifications')).toBe(false);
  });

  test('keeps navigation enabled while disabling settings in read-only mode', () => {
    render(
      <SettingsNavigation
        sections={[{
          id: 'model-selection',
          category: 'general',
          searchText: 'model',
          content: <input aria-label="Model setting" />
        }]}
        isReadOnly
      />
    );

    expect(screen.getByRole('searchbox', { name: 'Search settings' })).toBeEnabled();
    expect(screen.getByRole('tab', { name: 'Workflow & PR Rules' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Model setting' })).toBeDisabled();
  });
});
