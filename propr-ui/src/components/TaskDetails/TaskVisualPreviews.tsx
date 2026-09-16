import { ExternalLink } from 'lucide-react';
import { trustedPreviewMedia, type PublishedVisualPreview } from '@propr/shared';
import { PreviewImage } from '../PreviewMedia';

/** Visual evidence published by this specific task run. Renders nothing when the run published none. */
export default function TaskVisualPreviews({ previews }: { previews?: PublishedVisualPreview[] }) {
  const media = trustedPreviewMedia(previews, 8);
  if (!media.length) return null;
  return <section aria-labelledby="task-visual-previews-heading" className="border-b border-slate-200 px-4 py-4">
    <h2 id="task-visual-previews-heading" className="text-sm font-semibold text-slate-900">Visual Previews</h2>
    <div className="mt-3 grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-4">
      {media.map(preview => <figure key={preview.url} className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {preview.type === 'image'
          ? <a href={preview.url} target="_blank" rel="noopener noreferrer" aria-label={`Open full-size preview: ${preview.title}`} className="block bg-slate-50">
            <PreviewImage preview={preview} />
          </a>
          : <video src={preview.url} aria-label={preview.title} controls preload="metadata" playsInline className="aspect-video w-full bg-slate-950" />}
        <figcaption className="p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 break-words text-sm font-medium text-slate-800">{preview.title}</p>
            <a href={preview.url} target="_blank" rel="noopener noreferrer" aria-label={`Open original: ${preview.title}`}
              className="inline-flex min-h-6 shrink-0 items-center gap-1 text-xs font-medium text-sky-700 hover:underline">
              Original <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </div>
          {preview.description && <p className="mt-1 break-words text-xs leading-5 text-slate-500">{preview.description}</p>}
        </figcaption>
      </figure>)}
    </div>
  </section>;
}
