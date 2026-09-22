import { useCallback, useEffect, useRef, useState } from 'react';
import { Film, ImageOff } from 'lucide-react';
import { trustedPreviewMedia, type PublishedVisualPreview } from '@propr/shared';
import { downsampleToCanvas } from './previewDownsampling';

/** `className` replaces the default full-size sizing classes; compact thumbnails keep their fixed sizing. */
export function PreviewImage({ preview, compact = false, className: sizing }: { preview: PublishedVisualPreview; compact?: boolean; className?: string }) {
  const [failed, setFailed] = useState(false);
  const [downsampled, setDownsampled] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const className = compact ? 'h-12 w-full object-contain bg-slate-900/5 sm:h-14' : sizing ?? 'aspect-video w-full object-contain';

  const draw = useCallback(() => {
    const image = imageRef.current;
    const canvas = canvasRef.current;
    if (!compact || !image || !canvas || !image.complete) return;
    try {
      setDownsampled(downsampleToCanvas(image, canvas, image.clientWidth, image.clientHeight));
    } catch {
      setDownsampled(false); // The native image remains a complete fallback.
    }
  }, [compact]);

  useEffect(() => {
    setFailed(false);
    setDownsampled(false);
  }, [preview.url]);

  useEffect(() => {
    const image = imageRef.current;
    if (!compact || failed || !image) return;
    if (image.complete && image.naturalWidth) draw();
    if (typeof ResizeObserver === 'undefined') return;
    // Thumbnail widths change at breakpoints; redraw for the new backing size.
    const observer = new ResizeObserver(() => draw());
    observer.observe(image);
    return () => observer.disconnect();
  }, [compact, draw, failed, preview.url]);

  if (failed) return <span role="img" aria-label={`${preview.title} — image unavailable`} className={`${className} flex items-center justify-center bg-slate-100 text-slate-500`}><ImageOff className="h-5 w-5" /></span>;
  const image = <img ref={imageRef} src={preview.url} alt={preview.title} loading="lazy" onLoad={draw} onError={() => setFailed(true)}
    className={`${className}${compact && downsampled ? ' opacity-0' : ''}`} />;
  if (!compact) return image;
  // The image stays in the DOM for lazy loading, accessibility and fallback; the canvas is presentation only.
  return <span className="relative block">
    {image}
    <canvas ref={canvasRef} aria-hidden="true" data-testid="preview-thumbnail-canvas"
      className={`pointer-events-none absolute inset-0 m-auto ${downsampled ? '' : 'hidden'}`} />
  </span>;
}

/** Non-interactive so it can live inside a task/goal/Inbox navigation target. */
export function PreviewThumbnails({ media, limit = 3 }: { media?: unknown; limit?: 1 | 3 }) {
  const previews = trustedPreviewMedia(media, limit);
  if (!previews.length) return null;
  return <div role="group" aria-label="Published visual previews" className="mt-2 flex max-w-full flex-wrap gap-1.5">
    {previews.map(preview => <span key={preview.url} title={preview.title} className="block w-16 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-white sm:w-20">
      {preview.type === 'image' ? <PreviewImage preview={preview} compact />
        : <span role="img" aria-label={`Video preview: ${preview.title}`} className="flex h-12 flex-col items-center justify-center gap-0.5 bg-slate-800 text-white sm:h-14"><Film className="h-4 w-4" /><span className="text-[10px]">Video preview</span></span>}
    </span>)}
  </div>;
}
