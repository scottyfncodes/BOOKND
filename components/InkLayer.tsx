'use client';
import { useEffect, useRef } from 'react';
import { ink, runInk, type InkRun } from '@/lib/ink';

/** One canvas for the whole app. It draws only while a transition runs. */
export function InkLayer() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let current: InkRun | null = null;
    const stop = () => {
      current?.cancel();
      current = null;
    };
    const unsub = ink.subscribe((req) => {
      if (!ref.current) return;
      stop();
      // the page's ink colour follows the theme so the dark theme gets a warm "paper" flood instead
      const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
      current = runInk(ref.current, { color: req.color ?? (dark && req.kind !== 'ripple' ? '#2b2c29' : '#242522'), ...req });
      current.done.then(() => (current = null));
    });
    // Interruptible: any key press stops the ink immediately. Pointer input never waits on it either
    // (the canvas has pointer-events: none), but a second tap shouldn't leave ink on screen.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key.startsWith('Arrow')) stop();
    };
    const onHide = () => document.visibilityState === 'hidden' && stop();
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      unsub();
      stop();
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, []);
  return <canvas ref={ref} className="ink-layer" aria-hidden="true" />;
}
