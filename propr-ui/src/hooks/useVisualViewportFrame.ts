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
 * A dialog that stays mounted while closed passes `active` so the layer is
 * framed each time it renders.
 */
export function useVisualViewportFrame(ref: RefObject<HTMLElement | null>, active = true) {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const layer = ref.current;
    if (!active || !viewport || !layer) return;
    const reset = () => {
      for (const property of FRAME_PROPERTIES) layer.style.removeProperty(property);
      delete layer.dataset.visualViewport;
    };
    let frame = '';
    const update = () => {
      const next = Math.abs(viewport.scale - 1) > 0.01 ? null : clipToViewport(stylesheetRect(layer), viewport);
      const key = next ? `${next.top}:${next.bottom}` : '';
      if (key === frame) return;
      frame = key;
      if (!next) { reset(); return; }
      layer.style.top = `${next.top}px`;
      layer.style.bottom = 'auto';
      layer.style.height = `${Math.max(0, next.bottom - next.top)}px`;
      layer.dataset.visualViewport = 'clipped';
      // The pane just moved or shrank; keep the field being edited inside its scroll area.
      // An unchanged frame leaves the reader's own scroll position alone.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused !== layer && layer.contains(focused)) revealWithin(focused, layer, next.top, next.bottom);
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
  }, [ref, active]);
}

/**
 * The layer's rect under its stylesheet alone, read from an empty, invisible copy so the
 * live layer is never unframed: that would let its scroll areas grow for a moment and
 * clamp the reader's position in them (e.g. a log scrolled to a match near its end).
 */
function stylesheetRect(layer: HTMLElement) {
  const probe = document.createElement('div');
  probe.className = layer.className;
  probe.setAttribute('aria-hidden', 'true');
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  layer.before(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  return rect;
}

/** The part of `base` inside the visual viewport, or null when the viewport already shows all of it. */
function clipToViewport(base: DOMRect, viewport: VisualViewport) {
  const top = Math.max(base.top, viewport.offsetTop);
  const bottom = Math.min(base.bottom, viewport.offsetTop + viewport.height);
  return top - base.top < 1 && base.bottom - bottom < 1 ? null : { top, bottom };
}

/**
 * Scrolls `element`'s scroll container inside `layer` so it is shown between `top` and `bottom`. Only that
 * container moves: `scrollIntoView` would also scroll the pane's `overflow: hidden` box and
 * push the header out of view. A dialog that scrolls as a whole (a very short viewport)
 * stops short of scrolling its own heading away; a sticky heading stays put anyway.
 */
function revealWithin(element: HTMLElement, layer: HTMLElement, top: number, bottom: number) {
  let container: HTMLElement | null = element.parentElement;
  while (container && container !== layer && !/(auto|scroll)/.test(getComputedStyle(container).overflowY)) container = container.parentElement;
  if (!container || container === layer) return;
  const area = container.getBoundingClientRect();
  const low = Math.max(top, area.top);
  const high = Math.min(bottom, area.bottom);
  const rect = element.getBoundingClientRect();
  if (rect.top >= low - 1 && rect.bottom <= high + 1) return;
  // A field taller than the space left shows its start; otherwise all of it.
  const before = container.scrollTop;
  container.scrollTop += rect.top < low || rect.height > high - low ? rect.top - low : rect.bottom - high;
  const labelledBy = element.closest('[role="dialog"]')?.getAttribute('aria-labelledby');
  const heading = labelledBy ? document.getElementById(labelledBy) : null;
  if (!heading || !container.contains(heading)) return;
  const hidden = low - heading.getBoundingClientRect().top;
  if (hidden > 0) container.scrollTop = Math.max(before, container.scrollTop - hidden);
}
