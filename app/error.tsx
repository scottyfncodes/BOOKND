'use client';
import Link from 'next/link';
import { useEffect } from 'react';

/** Shown if a screen fails unexpectedly. Books and reading positions are untouched. */
export default function ErrorScreen({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="app-error" id="main" role="alert">
      <h1>Something went wrong</h1>
      <p>Your books, bookmarks and reading positions are safe on this device. Try again, or go back to your library.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button className="btn btn-primary" onClick={reset}>
          Try again
        </button>
        <Link className="btn btn-quiet" href="/library/">
          Library
        </Link>
      </div>
    </main>
  );
}
