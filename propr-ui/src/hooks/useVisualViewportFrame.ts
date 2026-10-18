import { useLayoutEffect, type RefObject } from 'react';

const FRAME_PROPERTIES = ['top', 'bottom', 'height'] as const;

/**
 * Keeps a `position: fixed` full-screen layer inside the area the user can see.
 *
 * An on-screen keyboard (Android Chrome, iOS Safari) shrinks and pans the visual
 * viewport while the layout viewport keeps its size, so an `inset-0` layer stays
 * partly above or below the visible area. While the visual viewport is smaller
 * than the layer, the layer is clipped to it; otherwise its stylesheet geometry
 * (including the desktop titlebar offset) applies unchanged. Pinch zoom is left
 * alone so a zoomed reader can still pan around the dialog.
 *
 * A clipped layer carries `data-visual-viewport="clipped"` so its content can
 * compact (e.g. `group-data-[visual-viewport=clipped]:`) to leave room to edit.
 */
export function useVisualViewportFrame(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const layer = ref.current;
    if (!viewport || !layer) return;
    const reset = () => {
      for (const property of FRAME_PROPERTIES) layer.style.removeProperty(property);
      delete layer.dataset.visualViewport;
    };
    let frame = '';
    const update = () => {
      reset();
      if (Math.abs(viewport.scale - 1) > 0.01) { frame = ''; return; }
      const base = layer.getBoundingClientRect();
      const top = Math.max(base.top, viewport.offsetTop);
      const bottom = Math.min(base.bottom, viewport.offsetTop + viewport.height);
      if (top - base.top < 1 && base.bottom - bottom < 1) { frame = ''; return; }
      layer.style.top = `${top}px`;
      layer.style.bottom = 'auto';
      layer.style.height = `${Math.max(0, bottom - top)}px`;
      layer.dataset.visualViewport = 'clipped';
      // The pane just moved or shrank; keep the field being edited inside its scroll area.
      // An unchanged frame leaves the reader's own scroll position alone.
      const next = `${top}:${bottom}`;
      const active = document.activeElement;
      if (next !== frame && active instanceof HTMLElement && active !== layer && layer.contains(active)) revealWithin(active, top, bottom);
      frame = next;
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      reset();
    };
  }, [ref]);
}

/** Scrolls `element` into its scroll container when it is not fully shown between `top` and `bottom`. */
function revealWithin(element: HTMLElement, top: number, bottom: number) {
  let low = top;
  let high = bottom;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (!/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) continue;
    const rect = parent.getBoundingClientRect();
    low = Math.max(low, rect.top);
    high = Math.min(high, rect.bottom);
    break;
  }
  const rect = element.getBoundingClientRect();
  if (rect.top >= low - 1 && rect.bottom <= high + 1) return;
  // A field taller than the space left shows its start; otherwise all of it.
  element.scrollIntoView({ block: rect.height > high - low ? 'start' : 'nearest', inline: 'nearest' });
}
