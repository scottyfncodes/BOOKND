'use client';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Toast = { id: number; text: string; tone: 'info' | 'error'; action?: { label: string; run: () => void } };
type Ctx = (text: string, opts?: { tone?: Toast['tone']; action?: Toast['action']; ms?: number }) => void;

const ToastCtx = createContext<Ctx>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback<Ctx>((text, opts = {}) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone: opts.tone ?? 'info', action: opts.action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.ms ?? (opts.tone === 'error' ? 7000 : 3500));
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === 'error' ? 'error' : ''}`} role={t.tone === 'error' ? 'alert' : undefined}>
            <span style={{ flex: 1 }}>{t.text}</span>
            {t.action ? (
              <button className="btn btn-text" style={{ color: 'inherit', minHeight: 36 }} onClick={t.action.run}>
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
