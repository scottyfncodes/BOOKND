'use client';
import { useEffect } from 'react';
import { ink } from '@/lib/ink';

/**
 * A restrained ink stroke drawn beneath the chapter name at the top of the page.
 * It sits in the margin, never over the text, ignores pointer input and removes itself.
 */
export function ChapterFlourish({ label, onDone }: { label: string; onDone: () => void }) {
  const animate = ink.enabled();
  useEffect(() => {
    const t = setTimeout(onDone, animate ? 2400 : 1600);
    return () => clearTimeout(t);
  }, [onDone, animate]);
  return (
    <div className={`chapter-flourish ${animate ? 'animate' : ''}`} aria-live="polite">
      <span className="label">{label}</span>
      <svg viewBox="0 0 240 16" aria-hidden="true" focusable="false">
        <path d="M4 9.5c22-5 44-6 70-3.5s40 5 64 3c22-2 38-6.5 64-6 14 .3 26 2 34 3.6" />
        <circle cx="236" cy="6.8" r="2.4" />
      </svg>
    </div>
  );
}
