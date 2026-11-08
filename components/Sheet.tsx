'use client';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { IconClose } from './Icons';

/** A modal bottom sheet (dialog on desktop). Traps focus, closes on Escape and returns focus. */
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
  useEffect(() => {
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
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
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
    </>
  );
}
