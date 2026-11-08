import type { NextConfig } from 'next';

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline' blob:",
  "img-src 'self' blob: data:",
  "font-src 'self' data: blob:",
  "connect-src 'self' blob: data:",
  "frame-src 'self' blob:",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  // /discover/ and /read/ resolve to folder index pages on any static host, too (offline snapshot, QA tooling)
  trailingSlash: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    ];
  },
};
export default config;
