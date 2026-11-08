'use client';
import { useEffect, type ReactNode } from 'react';
import { InkLayer } from './InkLayer';
import { ToastProvider } from './Toasts';
import { getPref } from '@/lib/db';
import { ink } from '@/lib/ink';

export function AppShell({ children }: { children: ReactNode }) {
  useEffect(() => {
    getPref('effects', true)
      .then((on) => {
        ink.setDecorative(on);
        document.documentElement.dataset.effects = on ? 'on' : 'off';
      })
      .catch(() => {});
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
      // Make the reader work offline before a book is ever opened: load the on-demand EPUB engine in idle
      // time, then hand every app chunk this page has used to the service worker to keep.
      const idle = (cb: () => void) => ('requestIdleCallback' in window ? window.requestIdleCallback(cb, { timeout: 4000 }) : setTimeout(cb, 2000));
      idle(async () => {
        try {
          await import('epubjs');
          const reg = await navigator.serviceWorker.ready;
          const urls = performance
            .getEntriesByType('resource')
            .map((e) => e.name)
            .filter((u) => {
              const url = new URL(u);
              return url.origin === location.origin && (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/fonts/'));
            });
          reg.active?.postMessage({ type: 'cache-urls', urls });
        } catch {
          /* offline or unsupported: the runtime cache fills in as pages are used */
        }
      });
    }
  }, []);
  return (
    <ToastProvider>
      {children}
      <InkLayer />
    </ToastProvider>
  );
}
