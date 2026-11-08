'use client';
import { liveQuery } from 'dexie';
import { useEffect, useMemo, useState, type DependencyList } from 'react';

/** Subscribes to a Dexie query and re-renders when the underlying tables change. */
export function useLive<T>(query: () => Promise<T>, deps: DependencyList, initial?: T): T | undefined {
  const [value, setValue] = useState<T | undefined>(initial);
  useEffect(() => {
    const sub = liveQuery(query).subscribe({ next: setValue, error: () => setValue(initial) });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

const pendingRevoke = new Map<string, ReturnType<typeof setTimeout>>();

/** An object URL for a Blob, revoked shortly after it is no longer used (safe under Strict Mode remounts). */
export function useObjectUrl(blob: Blob | undefined) {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : undefined), [blob]);
  useEffect(() => {
    if (!url) return;
    clearTimeout(pendingRevoke.get(url));
    pendingRevoke.delete(url);
    return () => {
      pendingRevoke.set(
        url,
        setTimeout(() => {
          URL.revokeObjectURL(url);
          pendingRevoke.delete(url);
        }, 1000),
      );
    };
  }, [url]);
  return url;
}
