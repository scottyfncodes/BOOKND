export type ThemeName = 'paper' | 'midnight' | 'ink';
export type FontChoice = 'serif' | 'sans' | 'publisher';
export type MarginChoice = 'narrow' | 'normal' | 'wide';

export interface ReaderPrefs {
  fontSize: number; // percent
  lineHeight: number;
  margin: MarginChoice;
  font: FontChoice;
  theme: ThemeName;
}

export const DEFAULT_PREFS: ReaderPrefs = { fontSize: 100, lineHeight: 1.6, margin: 'normal', font: 'serif', theme: 'paper' };

export const THEMES: Record<ThemeName, { label: string; bg: string; text: string; muted: string; link: string; chrome: string; dark: boolean }> = {
  paper: { label: 'Paper', bg: '#f4efe5', text: '#242522', muted: '#6a6d66', link: '#8f4a36', chrome: '#ebe5d8', dark: false },
  midnight: { label: 'Midnight', bg: '#1c1d1b', text: '#e9e3d7', muted: '#9c9d95', link: '#d9957c', chrome: '#262724', dark: true },
  ink: { label: 'Ink', bg: '#cfd5cd', text: '#1d211e', muted: '#4f5750', link: '#7a3e2c', chrome: '#c3cac1', dark: false },
};

/** epub.js puts half of this inside each page edge and all of it between two-page spreads (the gutter). */
export const PAGE_GAP = 56;

/** Total side margin of the text, in px (phone / wide screens). The viewer is inset by margin − PAGE_GAP / 2. */
export const MARGINS: Record<MarginChoice, { label: string; px: number; pxWide: number }> = {
  narrow: { label: 'Narrow', px: 28, pxWide: 40 },
  normal: { label: 'Normal', px: 36, pxWide: 72 },
  wide: { label: 'Wide', px: 52, pxWide: 120 },
};

export const FONTS: Record<FontChoice, { label: string; stack: string | null }> = {
  serif: { label: 'Baskerville', stack: "'Libre Baskerville', Georgia, serif" },
  sans: { label: 'Inter', stack: "'Inter', system-ui, sans-serif" },
  publisher: { label: 'Original', stack: null },
};

export const HIGHLIGHT_FILL = { oxide: '#c4744f', sage: '#7f9a86', stone: '#b9a98a' } as const;

export function clampPrefs(p: Partial<ReaderPrefs>): ReaderPrefs {
  const m = { ...DEFAULT_PREFS, ...p };
  return {
    fontSize: Math.min(200, Math.max(70, Math.round(m.fontSize / 5) * 5)),
    lineHeight: Math.min(2.2, Math.max(1.1, Math.round(m.lineHeight * 10) / 10)),
    margin: m.margin in MARGINS ? m.margin : 'normal',
    font: m.font in FONTS ? m.font : 'serif',
    theme: m.theme in THEMES ? m.theme : 'paper',
  };
}

/**
 * CSS injected into each chapter's document. Book text stays real, selectable HTML: this only
 * sets typography and colours. Publisher styles are kept where they don't fight the reader's choices.
 */
export function contentCss(p: ReaderPrefs, origin: string) {
  const t = THEMES[p.theme];
  const family = FONTS[p.font].stack;
  return `
@font-face{font-family:'Libre Baskerville';src:url('${origin}/fonts/libre-baskerville-400.woff2') format('woff2');font-weight:400;font-style:normal}
@font-face{font-family:'Libre Baskerville';src:url('${origin}/fonts/libre-baskerville-400-italic.woff2') format('woff2');font-weight:400;font-style:italic}
@font-face{font-family:'Libre Baskerville';src:url('${origin}/fonts/libre-baskerville-700.woff2') format('woff2');font-weight:700;font-style:normal}
@font-face{font-family:'Inter';src:url('${origin}/fonts/inter-var.woff2') format('woff2');font-weight:100 900}
html{background:transparent !important;-webkit-text-size-adjust:100%;}
body{color:${t.text} !important;background:transparent !important;font-size:${p.fontSize}% !important;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;hanging-punctuation:first;
  hyphens:auto;-webkit-hyphens:auto;overflow-wrap:break-word;}
body *{color:inherit !important;background-color:transparent !important;border-color:currentColor;}
p,li,blockquote,dd,dt,div,span,td{line-height:${p.lineHeight} !important;}
${family ? `body,p,div,span,li,blockquote,td,th,h1,h2,h3,h4,h5,h6,a,em,i,strong,b,small{font-family:${family} !important;}` : ''}
a,a *{color:${t.link} !important;}
img,svg,video{max-width:100% !important;height:auto;object-fit:contain;page-break-inside:avoid;break-inside:avoid;}
${t.dark ? 'img{filter:brightness(.88) contrast(1.05);}' : ''}
::selection{background:${t.dark ? 'rgba(217,149,124,.38)' : 'rgba(166,91,69,.24)'};}
`;
}
