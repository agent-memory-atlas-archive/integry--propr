import { useEffect } from 'react';

/** Lock the document and mobile task pane while a task sheet is open. */
export function useLockTaskScroll(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const scrollers = [document.body, ...document.querySelectorAll<HTMLElement>('[data-testid="task-details"]')];
    const previous = scrollers.map(node => node.style.overflow);
    scrollers.forEach(node => { node.style.overflow = 'hidden'; });
    return () => scrollers.forEach((node, index) => { node.style.overflow = previous[index]; });
  }, [open]);
}
