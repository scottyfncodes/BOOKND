'use client';
import { useState } from 'react';
import { useObjectUrl } from '@/lib/hooks';

/** A book's cover, or a typeset fallback in the brand's ink when the EPUB has none (or the image fails to load). */
export function BookCover({ cover, src, title, author }: { cover?: Blob; src?: string; title: string; author?: string }) {
  const blobUrl = useObjectUrl(cover);
  const url = src ?? blobUrl;
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <div className="cover">
      {url && failed !== url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(url)} />
      ) : (
        <div className="cover-fallback" aria-hidden="true">
          <span className="t">{title}</span>
          {author ? <span className="a">{author}</span> : null}
          <span className="drop" />
        </div>
      )}
    </div>
  );
}
