import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AppShell } from '@/components/AppShell';

/** HaveAnApp Pulse enrollment capture (see the Pulse repository's CLAUDE.md). */
const PULSE_ENROLL_CAPTURE =
  "try{var m=/^#pulse-enroll=([0-9a-f]{64})$/.exec(location.hash);if(m){sessionStorage.setItem('pulse:enroll',m[1]);history.replaceState(history.state,'',location.pathname+location.search)}}catch(e){}";

export const metadata: Metadata = {
  title: 'BookNd',
  description: 'A calm, beautiful e-reader for your EPUBs and free public-domain classics.',
  applicationName: 'BookNd',
  authors: [{ name: 'HaveAnApp' }],
  manifest: '/manifest.webmanifest',
  // App icon set from the approved master (GITCRAFT icons.snippet.json)
  icons: {
    icon: [
      { url: '/assets/icons/icon.svg', type: 'image/svg+xml' },
      { url: '/assets/icons/favicon.ico', sizes: '48x48' },
      { url: '/assets/icons/favicon-32.png', type: 'image/png', sizes: '32x32' },
      { url: '/assets/icons/favicon-16.png', type: 'image/png', sizes: '16x16' },
    ],
    apple: [{ url: '/assets/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
  appleWebApp: { capable: true, title: 'BookNd', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4efe5' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1d1b' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preload" href="/fonts/libre-baskerville-400.woff2" as="font" type="font/woff2" crossOrigin="" />
        <link rel="preload" href="/fonts/inter-var.woff2" as="font" type="font/woff2" crossOrigin="" />
        {/* Pulse owner enrollment: runs before any app code (the router rewrites the address on load) and hands the
            one-time #pulse-enroll code to the tracker through this tab's session storage. Inert without that fragment. */}
        <script dangerouslySetInnerHTML={{ __html: PULSE_ENROLL_CAPTURE }} />
        {/* HaveAnApp Pulse: anonymous, cookieless usage counts, plus a random returning-visitor id kept on this device for this app. */}
        <script defer src="https://haveanapp-pulse-collect.vercel.app/p.js" data-app="booknd" data-returning="on" />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
