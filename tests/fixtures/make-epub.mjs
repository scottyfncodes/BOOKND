// Builds test EPUBs: a multi-chapter EPUB 3 with a cover, an inline image, nav + NCX and long-form text,
// plus a DRM-marked EPUB and a broken file. Text: Jane Austen, "Pride and Prejudice" (1813, public domain).
import JSZip from 'jszip';
import { writeFileSync, readFileSync } from 'node:fs';

const OPENING = [
  'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.',
  'However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered as the rightful property of some one or other of their daughters.',
  '“My dear Mr. Bennet,” said his lady to him one day, “have you heard that Netherfield Park is let at last?”',
  'Mr. Bennet replied that he had not.',
  '“But it is,” returned she; “for Mrs. Long has just been here, and she told me all about it.”',
  'Mr. Bennet made no answer.',
  '“Do not you want to know who has taken it?” cried his wife impatiently.',
  '“You want to tell me, and I have no objection to hearing it.”',
  'This was invitation enough.',
];
const FILLER = (n, ch) =>
  Array.from({ length: n }, (_, i) =>
    `Paragraph ${i + 1} of chapter ${ch}. The afternoon light lay across the drawing room as the family considered the news; every remark was weighed, repeated and improved upon, until the smallest circumstance had grown into a matter of the greatest consequence. Lantern${ch}x${i} marks this passage for the search test.`,
  );

const png = readFileSync(new URL('./plate.png', import.meta.url));

function xhtml(title, body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><title>${title}</title><link rel="stylesheet" type="text/css" href="../css/book.css"/></head>
<body>${body}</body></html>`;
}

export async function makeEpub({ drm = false, chapters = 6 } = {}) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  if (drm) {
    zip.file('META-INF/encryption.xml', `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
  <enc:CipherData><enc:CipherReference URI="OEBPS/text/ch1.xhtml"/></enc:CipherData></enc:EncryptedData>
</encryption>`);
  }
  zip.file('OEBPS/css/book.css', 'body{font-family:serif} h1{text-align:center;margin:2em 0 1em} p{text-indent:1.2em;margin:0} .fig{text-align:center;margin:1em 0} script{display:none}');
  zip.file('OEBPS/images/cover.png', png);
  zip.file('OEBPS/images/plate.png', png);
  const items = [];
  const titles = [];
  for (let c = 1; c <= chapters; c++) {
    const title = `Chapter ${['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'][c - 1] ?? c}`;
    titles.push(title);
    const paras = (c === 1 ? OPENING : []).concat(FILLER(c === 1 ? 30 : 40, c));
    const img = c === 2 ? '<div class="fig"><img src="../images/plate.png" alt="An ink-drop plate"/></div>' : '';
    // a hostile script that must never run (the reader sandboxes book content)
    const script = c === 1 ? '<script>window.parent.__bookScriptRan = true;</script>' : '';
    zip.file(`OEBPS/text/ch${c}.xhtml`, xhtml(title, `<section epub:type="chapter"><h1>${title}</h1>${img}${script}${paras.map((p) => `<p>${p}</p>`).join('\n')}</section>`));
    items.push(c);
  }
  zip.file('OEBPS/text/cover.xhtml', xhtml('Cover', '<div style="text-align:center"><img src="../images/cover.png" alt="Cover"/></div>'));
  zip.file('OEBPS/nav.xhtml', xhtml('Contents', `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${titles.map((t, i) => `<li><a href="text/ch${i + 1}.xhtml">${t}</a></li>`).join('')}</ol></nav>`));
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:booknd-fixture"/></head>
<docTitle><text>Pride and Prejudice (BookNd test edition)</text></docTitle><navMap>
${titles.map((t, i) => `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${t}</text></navLabel><content src="text/ch${i + 1}.xhtml"/></navPoint>`).join('\n')}
</navMap></ncx>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="uid">urn:uuid:booknd-fixture${drm ? '-drm' : ''}</dc:identifier>
    <dc:title>Pride and Prejudice (BookNd test edition)</dc:title>
    <dc:creator opf:role="aut">Jane Austen</dc:creator>
    <dc:language>en</dc:language>
    <dc:publisher>BookNd fixtures</dc:publisher>
    <dc:description>&lt;p&gt;A test edition with &lt;b&gt;chapters&lt;/b&gt;, an image and long-form text.&lt;/p&gt;</dc:description>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="css/book.css" media-type="text/css"/>
    <item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="plate" href="images/plate.png" media-type="image/png"/>
    <item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
    ${items.map((c) => `<item id="ch${c}" href="text/ch${c}.xhtml" media-type="application/xhtml+xml"${c === 1 ? ' properties="scripted"' : ''}/>`).join('\n    ')}
  </manifest>
  <spine toc="ncx">
    <itemref idref="cover"/>
    ${items.map((c) => `<itemref idref="ch${c}"/>`).join('\n    ')}
  </spine>
</package>`);
  return zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' });
}

if (process.argv[1] && process.argv[1].endsWith('make-epub.mjs')) {
  const out = new URL('./', import.meta.url);
  writeFileSync(new URL('pride-test.epub', out), await makeEpub());
  writeFileSync(new URL('drm-test.epub', out), await makeEpub({ drm: true }));
  writeFileSync(new URL('broken.epub', out), Buffer.from('this is not a zip file'));
  console.log('fixtures written');
}
