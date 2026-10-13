import { useSearchParams } from 'react-router-dom';
import { DEFAULT_SETTINGS_CATEGORY, SETTINGS_CATEGORIES, type SettingsCategoryId } from './SettingsNavigation';

/** Tabs from the old horizontal layout, kept so saved links keep landing nearby. */
const LEGACY_SETTINGS_CATEGORIES: Record<string, SettingsCategoryId> = {
  automation: 'workflow',
};

const settingsCategoryFrom = (value: string | null): SettingsCategoryId => {
  if (value && value in LEGACY_SETTINGS_CATEGORIES) return LEGACY_SETTINGS_CATEGORIES[value];
  return SETTINGS_CATEGORIES.some(category => category.id === value)
    ? value as SettingsCategoryId
    : DEFAULT_SETTINGS_CATEGORY;
};

export const useSettingsCategoryRoute = (): {
  activeCategory: SettingsCategoryId;
  onActiveCategoryChange(category: SettingsCategoryId): void;
  /** The URL names a category, so phones open it directly instead of the category list. */
  openCategoryOnMobile: boolean;
} => {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeCategory = settingsCategoryFrom(searchParams.get('tab'));

  const onActiveCategoryChange = (category: SettingsCategoryId): void => {
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      if (category === DEFAULT_SETTINGS_CATEGORY) next.delete('tab');
      else next.set('tab', category);
      return next;
    }, { replace: true });
  };

  return { activeCategory, onActiveCategoryChange, openCategoryOnMobile: searchParams.has('tab') };
};
