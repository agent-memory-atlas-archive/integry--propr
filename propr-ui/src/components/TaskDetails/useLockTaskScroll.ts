import { useEffect } from 'react';

// Both task sheets can own a lock. Only the last owner restores the page.
let owners = 0;
let restore: (() => void) | undefined;

/** Lock the document and explicitly marked task panes while a task sheet is open. */
export function useLockTaskScroll(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    if (owners++ === 0) {
      const body = document.body;
      const x = window.scrollX;
      const y = window.scrollY;
      const properties = ['overflow', 'position', 'top', 'left', 'width'] as const;
      const previous = properties.map(key => [key, body.style.getPropertyValue(key), body.style.getPropertyPriority(key)]);
      const panes = [...document.querySelectorAll<HTMLElement>('[data-scroll-lock-target]')];
      const overflows = panes.map(node => [node.style.getPropertyValue('overflow'), node.style.getPropertyPriority('overflow')]);
      body.style.overflow = 'hidden';
      // Fixed positioning also locks the document scroller on iOS Safari.
      body.style.position = 'fixed';
      body.style.top = `${-y}px`;
      body.style.left = `${-x}px`;
      body.style.width = '100%';
      panes.forEach(node => { node.style.overflow = 'hidden'; });
      restore = () => {
        previous.forEach(([key, value, priority]) => body.style.setProperty(key, value, priority));
        panes.forEach((node, index) => node.style.setProperty('overflow', ...overflows[index] as [string, string]));
        window.scrollTo({ left: x, top: y, behavior: 'instant' });
      };
    }
    return () => {
      if (--owners === 0) {
        restore?.();
        restore = undefined;
      }
    };
  }, [open]);
}
