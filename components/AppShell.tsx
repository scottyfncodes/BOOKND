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
    }
  }, []);
  return (
    <ToastProvider>
      {children}
      <InkLayer />
    </ToastProvider>
  );
}
