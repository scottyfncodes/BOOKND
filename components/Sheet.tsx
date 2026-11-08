'use client';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from './Icons';

/**
 * A modal bottom sheet (dialog on desktop). Rendered in a portal as one fixed layer; the page behind it
 * is made inert (unreachable by tap, keyboard and screen readers) while it is open. Traps focus,
 * closes on Escape or a tap outside, and returns focus.
 */
export function Sheet({
  title,
  onClose,
  children,
  side,
  actions,
  className,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  side?: boolean;
  actions?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  // Sheets only open after an interaction, so the document is always there; inside the reader they carry
  // the reading theme's colours with them.
  const [host] = useState<HTMLElement | null>(() => (typeof document === 'undefined' ? null : document.body));
  const rootRef = useRef<HTMLDivElement>(null);
  // Inside the reader, follow its theme (also when it changes while the sheet is open, e.g. Reading settings).
  useLayoutEffect(() => {
    const root = rootRef.current;
    const reader = document.querySelector<HTMLElement>('.reader');
    if (!root || !reader) return;
    root.classList.forEach((c) => c.startsWith('theme-') && root.classList.remove(c));
    root.classList.add('reader-themed', ...Array.from(reader.classList).filter((c) => c.startsWith('theme-')));
    root.setAttribute('style', reader.getAttribute('style') ?? '');
  });
  useEffect(() => {
    if (!host) return;
    const behind = Array.from(document.querySelectorAll<HTMLElement>('.page, .reader')).filter((el) => !el.inert);
    behind.forEach((el) => (el.inert = true));
    return () => behind.forEach((el) => (el.inert = false));
  }, [host]);
  useEffect(() => {
    if (!host) return;
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () =>
      Array.from(node?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter(
        (el) => !el.hasAttribute('disabled'),
      );
    (node?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[1] ?? focusables()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [onClose, host]);
  if (!host) return null;
  return createPortal(
    <div
      ref={rootRef}
      className={`sheet-root ${side ? 'side' : ''}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className={`sheet ${side ? 'side' : ''} ${className ?? ''}`} role="dialog" aria-modal="true" aria-labelledby={id}>
        <div className="sheet-head">
          <h2 id={id}>{title}</h2>
          {actions}
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    host,
  );
}
