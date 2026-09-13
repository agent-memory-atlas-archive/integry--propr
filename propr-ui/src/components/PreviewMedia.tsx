import { useState } from 'react';
import { Film, ImageOff } from 'lucide-react';
import { trustedPreviewMedia, type PublishedVisualPreview } from '@propr/shared';

export function PreviewImage({ preview, compact = false }: { preview: PublishedVisualPreview; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  const className = compact ? 'h-12 w-full object-cover sm:h-14' : 'aspect-video w-full object-contain';
  if (failed) return <span role="img" aria-label={`${preview.title} — image unavailable`} className={`${className} flex items-center justify-center bg-slate-100 text-slate-500`}><ImageOff className="h-5 w-5" /></span>;
  return <img src={preview.url} alt={preview.title} loading="lazy" onError={() => setFailed(true)} className={className} />;
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
