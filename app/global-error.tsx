'use client';
import './globals.css';

/** Last-resort screen if the app shell itself fails to render. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="app-error" role="alert">
          <h1>BookNd couldn’t start</h1>
          <p>Your books are still stored on this device. Reload to try again.</p>
          <button className="btn btn-primary" onClick={() => (reset ? reset() : location.reload())}>
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
