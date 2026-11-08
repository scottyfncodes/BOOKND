'use client';
import { useEffect, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { useToast } from './Toasts';
import { IconDownload, IconUpload } from './Icons';
import { exportBackup, importBackup } from '@/lib/backup';
import { getPref, setPref } from '@/lib/db';
import { ink } from '@/lib/ink';
import { describeImportError, formatBytes, requestPersistence, storageEstimate } from '@/lib/library';

export function LibrarySettings({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [effects, setEffects] = useState(true);
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof storageEstimate>>>(null);
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getPref('effects', true).then(setEffects);
    storageEstimate().then(setUsage);
  }, []);

  const toggleEffects = async (on: boolean) => {
    setEffects(on);
    ink.setDecorative(on);
    document.documentElement.dataset.effects = on ? 'on' : 'off';
    await setPref('effects', on);
  };

  return (
    <Sheet title="Settings" onClose={onClose}>
      <div className="setting">
        <label className="switch">
          <span>
            Liquid-ink effects
            <small className="muted" style={{ display: 'block', fontSize: 13 }}>
              Ink transitions when opening books, chapter flourishes and highlights. Reduced-motion settings always turn them off.
            </small>
          </span>
          <input type="checkbox" role="switch" checked={effects} onChange={(e) => toggleEffects(e.target.checked)} data-autofocus />
        </label>
      </div>

      <div className="setting">
        <div className="setting-label">
          <span>Storage</span>
          <output>{usage ? `${formatBytes(usage.usage)} used` : '—'}</output>
        </div>
        <p className="muted" style={{ fontSize: 14, margin: 0 }}>
          Books, reading positions, bookmarks and highlights are stored only in this browser. They are never uploaded.{' '}
          <strong style={{ color: 'var(--text)' }}>Clearing this site&apos;s data, or uninstalling the app, deletes them.</strong>{' '}
          {usage && !usage.persisted ? 'The browser may also clear storage when the device is low on space.' : null}
        </p>
        {usage && !usage.persisted ? (
          <button
            className="btn btn-quiet"
            style={{ justifySelf: 'start' }}
            onClick={async () => {
              await requestPersistence();
              const u = await storageEstimate();
              setUsage(u);
              toast(u?.persisted ? 'Storage is now protected.' : 'Your browser decides this automatically; keeping a backup is the safest option.');
            }}
          >
            Ask the browser to keep my books
          </button>
        ) : null}
      </div>

      <div className="setting">
        <div className="setting-label">
          <span>Backup</span>
        </div>
        <p className="muted" style={{ fontSize: 14, margin: 0 }}>
          Save every book with your progress, bookmarks and highlights as one file. Restore it here on any device.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={async () => {
              setBusy('export');
              try {
                const blob = await exportBackup();
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `booknd-backup-${new Date().toISOString().slice(0, 10)}.zip`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 10000);
              } catch {
                toast('The backup could not be created.', { tone: 'error' });
              }
              setBusy(null);
            }}
          >
            <IconDownload width={18} height={18} /> {busy === 'export' ? 'Preparing…' : 'Export backup'}
          </button>
          <button className="btn btn-quiet" disabled={busy !== null} onClick={() => file.current?.click()}>
            <IconUpload width={18} height={18} /> {busy === 'import' ? 'Restoring…' : 'Restore backup'}
          </button>
          <input
            ref={file}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              setBusy('import');
              try {
                const r = await importBackup(f);
                toast(r.added ? `Restored ${r.added} book${r.added === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already here)` : ''}.` : 'Everything in this backup is already in your library.');
              } catch (err) {
                toast(err instanceof Error && /backup/.test(err.message) ? err.message : describeImportError(err), { tone: 'error' });
              }
              setBusy(null);
            }}
          />
        </div>
      </div>
    </Sheet>
  );
}
