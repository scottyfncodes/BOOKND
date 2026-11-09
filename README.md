# BookNd

A calm, beautiful, local-first EPUB reader. *The interface is alive. The reading experience is still.*

- Import your own DRM-free EPUBs, or add free public-domain classics from Standard Ebooks and Project Gutenberg.
- Paginated reading with themes, typography controls, bookmarks, highlights, search and a table of contents.
- Everything stays on your device (IndexedDB). Installable as a PWA and readable offline.

## Develop

```bash
npm install
npm run dev          # http://localhost:3000
npm run typecheck && npm run lint && npm test
npm run build && npm start -- -p 3100
BASE_URL=http://localhost:3100 npm run e2e   # Chromium end-to-end checks (phone + desktop)
```

Stack: Next.js (App Router), React, TypeScript, Tailwind CSS, epub.js, Dexie. No database, no accounts.

Discover searches one unified catalog (every readable Project Gutenberg ebook and every released Standard Ebooks title, editions grouped into works, Open Library ratings), rebuilt daily from official bulk metadata by the `Catalog` GitHub workflow. See [docs/catalog.md](docs/catalog.md).

BookNd by [HaveAnApp](https://haveanapp.com).
