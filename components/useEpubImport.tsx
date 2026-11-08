'use client';
import { useCallback, useRef, useState } from 'react';
import { describeImportError, importEpub } from '@/lib/library';
import { useToast } from './Toasts';

/** The "Import EPUB" flow: native file picker → validate → store locally → confirm. */
export function useEpubImport(onAdded?: (id: string) => void) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const importFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (!list.length) return;
      setBusy(true);
      let added = 0;
      let lastId = '';
      for (const file of list) {
        try {
          if (!/\.epub$/i.test(file.name) && file.type && file.type !== 'application/epub+zip') {
            toast(`“${file.name}” isn't an EPUB file.`, { tone: 'error' });
            continue;
          }
          const res = await importEpub(await file.arrayBuffer(), { source: 'import', fallbackTitle: file.name.replace(/\.epub$/i, '') });
          if (res.status === 'duplicate') toast(`“${res.book.title}” is already in your library.`);
          else {
            added++;
            lastId = res.book.id;
          }
        } catch (err) {
          toast(list.length > 1 ? `${file.name}: ${describeImportError(err)}` : describeImportError(err), { tone: 'error' });
        }
      }
      setBusy(false);
      if (added) {
        toast(added === 1 ? 'Added to your library.' : `${added} books added to your library.`);
        onAdded?.(lastId);
      }
    },
    [toast, onAdded],
  );

  const picker = (
    <input
      ref={input}
      type="file"
      accept=".epub,application/epub+zip"
      multiple
      hidden
      data-testid="epub-input"
      onChange={(e) => {
        const files = e.target.files;
        if (files) void importFiles(files);
        e.target.value = '';
      }}
    />
  );

  return { pick: () => input.current?.click(), picker, busy, importFiles };
}
