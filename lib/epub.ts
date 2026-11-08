import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

/** Why an EPUB was refused, in words a reader can act on. */
export class EpubError extends Error {
  constructor(
    public code: 'not-zip' | 'not-epub' | 'drm' | 'no-content' | 'too-large',
    message: string,
  ) {
    super(message);
    this.name = 'EpubError';
  }
}

export interface EpubMetadata {
  title: string;
  author: string;
  language?: string;
  description?: string;
  publisher?: string;
  cover?: { data: Uint8Array; type: string };
}

export const MAX_EPUB_BYTES = 200 * 1024 * 1024;

/** Font obfuscation is allowed (it is not DRM); anything else in encryption.xml is. */
const FONT_OBFUSCATION = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
]);

const NS = {
  container: 'urn:oasis:names:tc:opendocument:xmlns:container',
  opf: 'http://www.idpf.org/2007/opf',
  dc: 'http://purl.org/dc/elements/1.1/',
};

function parseXml(text: string) {
  return new DOMParser({
    errorHandler: { warning: () => {}, error: () => {}, fatalError: () => {} },
  }).parseFromString(text, 'application/xml');
}

function text(el: Element | null | undefined) {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function first(doc: Document | Element, ns: string, tag: string): Element | null {
  const list = doc.getElementsByTagNameNS(ns, tag);
  return list.length ? (list[0] as Element) : null;
}

function all(doc: Document | Element, ns: string, tag: string): Element[] {
  return Array.from(doc.getElementsByTagNameNS(ns, tag) as unknown as ArrayLike<Element>);
}

/** Resolves an href relative to the OPF's folder inside the zip. */
export function resolveZipPath(base: string, href: string) {
  const parts = (base ? base.split('/') : []).concat(decodeURIComponent(href.split('#')[0]).split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

/** Strips HTML from an OPF description so it is safe to show as plain text. */
export function plainText(html: string) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validates a DRM-free EPUB and extracts its metadata and cover.
 * Throws EpubError with a reader-facing message when the file can't be used.
 */
export async function inspectEpub(bytes: ArrayBuffer): Promise<EpubMetadata> {
  if (bytes.byteLength > MAX_EPUB_BYTES) {
    throw new EpubError('too-large', 'This file is larger than 200 MB, which is too big to store in the browser.');
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new EpubError('not-zip', "This file isn't an EPUB. It may be damaged, or a different format such as PDF or MOBI.");
  }

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) {
    throw new EpubError('not-epub', "This file isn't a valid EPUB: it has no META-INF/container.xml.");
  }

  if (zip.file('META-INF/rights.xml')) {
    throw new EpubError('drm', 'This book is protected by DRM. BookNd can only open DRM-free EPUBs.');
  }
  const encryption = zip.file('META-INF/encryption.xml');
  if (encryption) {
    const doc = parseXml(await encryption.async('string'));
    const methods = Array.from(doc.getElementsByTagName('*') as unknown as ArrayLike<Element>)
      .filter((el) => el.localName === 'EncryptionMethod')
      .map((el) => el.getAttribute('Algorithm') ?? '');
    if (methods.some((m) => !FONT_OBFUSCATION.has(m))) {
      throw new EpubError('drm', 'This book is protected by DRM. BookNd can only open DRM-free EPUBs.');
    }
  }

  const container = parseXml(await containerFile.async('string'));
  const rootfile = first(container, NS.container, 'rootfile') ?? container.getElementsByTagName('rootfile')[0];
  const opfPath = rootfile?.getAttribute('full-path');
  const opfFile = opfPath ? zip.file(opfPath) : null;
  if (!opfPath || !opfFile) {
    throw new EpubError('not-epub', "This file isn't a valid EPUB: its package document is missing.");
  }
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const opf = parseXml(await opfFile.async('string'));

  const manifest = all(opf, NS.opf, 'item');
  const spine = all(opf, NS.opf, 'itemref');
  if (!spine.length) {
    throw new EpubError('no-content', 'This EPUB has no readable chapters.');
  }

  const creators = all(opf, NS.dc, 'creator');
  // Prefer creators marked as authors (EPUB 2 opf:role="aut"); fall back to all creators.
  const authors = creators.filter((c) => {
    const role = c.getAttributeNS(NS.opf, 'role') || c.getAttribute('opf:role');
    return !role || role === 'aut';
  });
  const author = (authors.length ? authors : creators).map(text).filter(Boolean).slice(0, 3).join(', ');

  const meta: EpubMetadata = {
    title: text(first(opf, NS.dc, 'title')) || 'Untitled',
    author: author || 'Unknown author',
    language: text(first(opf, NS.dc, 'language')) || undefined,
    publisher: text(first(opf, NS.dc, 'publisher')) || undefined,
  };
  const description = plainText(text(first(opf, NS.dc, 'description')));
  if (description) meta.description = description.slice(0, 2000);

  // Cover: EPUB 3 properties="cover-image", EPUB 2 <meta name="cover">, then a guide reference or an id/href containing "cover".
  let coverItem = manifest.find((i) => (i.getAttribute('properties') ?? '').split(/\s+/).includes('cover-image'));
  if (!coverItem) {
    const coverMeta = all(opf, NS.opf, 'meta').find((m) => m.getAttribute('name') === 'cover');
    const id = coverMeta?.getAttribute('content');
    if (id) coverItem = manifest.find((i) => i.getAttribute('id') === id);
  }
  if (!coverItem) {
    coverItem = manifest.find(
      (i) => /^image\//.test(i.getAttribute('media-type') ?? '') && /cover/i.test(`${i.getAttribute('id')} ${i.getAttribute('href')}`),
    );
  }
  const coverHref = coverItem?.getAttribute('href');
  const coverType = coverItem?.getAttribute('media-type') ?? '';
  if (coverHref && /^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(coverType)) {
    const f = zip.file(resolveZipPath(opfDir, coverHref));
    if (f) meta.cover = { data: await f.async('uint8array'), type: coverType };
  }
  return meta;
}

export async function sha256(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
