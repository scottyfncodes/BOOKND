'use client';
import { Sheet } from '../Sheet';
import type { FlatToc } from './Reader';

const path = (h: string) => decodeURIComponent(h.split('#')[0]).replace(/^\.?\//, '');

export function ContentsSheet({ toc, currentHref, onPick, onClose }: { toc: FlatToc[]; currentHref?: string; onPick: (href: string) => void; onClose: () => void }) {
  let currentIdx = -1;
  toc.forEach((t, i) => {
    if (currentHref && path(t.href) === currentHref) currentIdx = currentIdx === -1 ? i : currentIdx;
  });
  return (
    <Sheet title="Contents" onClose={onClose} side>
      {toc.length ? (
        <ol className="list">
          {toc.map((t, i) => (
            <li key={`${t.href}-${i}`}>
              <button
                className="row-btn"
                style={{ paddingLeft: t.depth * 16 }}
                onClick={() => onPick(t.href)}
                aria-current={i === currentIdx ? 'true' : undefined}
                data-autofocus={i === currentIdx ? '' : undefined}
              >
                <span className={t.depth ? '' : 'serif'} style={{ fontSize: t.depth ? 14 : 15 }}>
                  {t.label || 'Untitled section'}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">This book doesn’t include a table of contents.</p>
      )}
    </Sheet>
  );
}
