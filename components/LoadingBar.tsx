'use client';
import { useEffect, useState } from 'react';

/**
 * A calm progress bar shown while the shelf fills, instead of empty cover outlines.
 * While the catalog request is out (`covers` absent) it creeps toward 60%; once results
 * are in, the rest of the bar follows the covers that have actually arrived.
 */
export function LoadingBar({ label = 'Gathering books…', covers }: { label?: string; covers?: { loaded: number; total: number } | null }) {
  const [shown, setShown] = useState(0.06);
  const target = covers && covers.total > 0 ? 0.6 + 0.4 * (covers.loaded / covers.total) : covers ? 1 : null;

  useEffect(() => {
    if (target !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShown((s) => Math.max(s, target));
      return;
    }
    // no real progress to report yet: ease toward 60% so the bar always feels alive
    const t = setInterval(() => setShown((s) => s + (0.6 - s) * 0.08), 200);
    return () => clearInterval(t);
  }, [target]);

  const pct = Math.round(shown * 100);
  return (
    <div className="loading-books" role="status">
      {/* a thin twin pinned to the top of the screen, so progress shows even when the shelf is below the fold */}
      <div className="loading-top" aria-hidden="true">
        <span style={{ transform: `scaleX(${shown})` }} />
      </div>
      <div className="loading-bar" role="progressbar" aria-label="Loading books" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ transform: `scaleX(${shown})` }} />
      </div>
      <p className="muted">{covers ? 'Setting out the covers…' : label}</p>
    </div>
  );
}

/** Fetches cover images into the browser cache, reporting each one, and gives up waiting after `timeout` ms. */
export function preloadCovers(urls: string[], onProgress: (loaded: number) => void, timeout = 6000): Promise<void> {
  if (!urls.length) return Promise.resolve();
  let loaded = 0;
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
    for (const url of urls) {
      const img = new Image();
      img.decoding = 'async';
      const done = () => {
        loaded++;
        onProgress(loaded);
        if (loaded === urls.length) {
          clearTimeout(timer);
          resolve();
        }
      };
      img.onload = done;
      img.onerror = done; // a broken cover shows the typeset fallback, so it's still "ready"
      img.src = url;
    }
  });
}
