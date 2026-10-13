import { useState, useCallback } from 'react';
type SaveList = (items: string[]) => void;

/**
 * One tag list: the saved items plus the text still being typed. `add` takes
 * an explicit value so a comma or blur can commit text that has not reached
 * state yet; it defaults to the typed text.
 */
function useTagList(save: SaveList) {
  const [items, setItems] = useState<string[]>([]);
  const [draft, setDraft] = useState('');

  const add = useCallback((value: string = draft) => {
    const item = value.trim();
    if (!item || items.includes(item)) return;
    const newList = [...items, item];
    setItems(newList);
    setDraft('');
    save(newList);
  }, [draft, items, save]);

  const remove = useCallback((item: string) => {
    const newList = items.filter(i => i !== item);
    setItems(newList);
    save(newList);
  }, [items, save]);

  return { items, setItems, draft, setDraft, add, remove };
}

export function useListManagement(
  saveWhitelist: SaveList,
  savePrimaryLabels: SaveList,
  saveKeywords: SaveList,
  saveIgnoreKeywords: SaveList
) {
  const whitelist = useTagList(saveWhitelist);
  const primaryLabels = useTagList(savePrimaryLabels);
  const keywords = useTagList(saveKeywords);
  const ignoreKeywords = useTagList(saveIgnoreKeywords);

  return {
    whitelist: whitelist.items, setWhitelist: whitelist.setItems,
    newWhitelistItem: whitelist.draft, setNewWhitelistItem: whitelist.setDraft,
    primaryLabels: primaryLabels.items, setPrimaryLabels: primaryLabels.setItems,
    newPrimaryLabel: primaryLabels.draft, setNewPrimaryLabel: primaryLabels.setDraft,
    keywords: keywords.items, setKeywords: keywords.setItems,
    newKeyword: keywords.draft, setNewKeyword: keywords.setDraft,
    ignoreKeywords: ignoreKeywords.items, setIgnoreKeywords: ignoreKeywords.setItems,
    newIgnoreKeyword: ignoreKeywords.draft, setNewIgnoreKeyword: ignoreKeywords.setDraft,
    addWhitelistItem: whitelist.add, removeWhitelistItem: whitelist.remove,
    addPrimaryLabel: primaryLabels.add, removePrimaryLabel: primaryLabels.remove,
    addKeyword: keywords.add, removeKeyword: keywords.remove,
    addIgnoreKeyword: ignoreKeywords.add, removeIgnoreKeyword: ignoreKeywords.remove,
  };
}
