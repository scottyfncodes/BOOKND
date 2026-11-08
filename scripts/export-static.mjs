// Assembles a static snapshot of the production build in out/ (run after `next build`).
// Used for static QA tooling and offline inspection. The catalog/download API routes need the
// Next.js server and are not part of the snapshot, so Discover shows its "catalog unavailable" state there.
import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const app = join(root, '.next/server/app');
const out = join(root, 'out');
if (!existsSync(join(app, 'index.html'))) {
  console.error('No production build found: run `npm run build` first.');
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'public'), out, { recursive: true });
cpSync(join(root, '.next/static'), join(out, '_next/static'), { recursive: true });
copyFileSync(join(app, 'index.html'), join(out, 'index.html'));
for (const page of ['discover', 'library', 'read']) {
  mkdirSync(join(out, page), { recursive: true });
  copyFileSync(join(app, `${page}.html`), join(out, page, 'index.html'));
}
copyFileSync(join(app, '_not-found.html'), join(out, '404.html'));
console.log('static snapshot written to out/');
