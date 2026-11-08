import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
  ...p,
});

export const IconBack = (p: P) => (<svg {...base(p)}><path d="M15 5l-7 7 7 7" /></svg>);
export const IconClose = (p: P) => (<svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>);
export const IconPlus = (p: P) => (<svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>);
export const IconSearch = (p: P) => (<svg {...base(p)}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>);
export const IconList = (p: P) => (<svg {...base(p)}><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r=".6" fill="currentColor" /><circle cx="4.5" cy="12" r=".6" fill="currentColor" /><circle cx="4.5" cy="18" r=".6" fill="currentColor" /></svg>);
export const IconType = (p: P) => (<svg {...base(p)}><path d="M4 19l5-14 5 14M5.8 14h6.4M15 19l3-8 3 8M15.9 16.5h4.2" /></svg>);
export const IconBookmark = ({ filled, ...p }: P & { filled?: boolean }) => (<svg {...base(p)}><path d="M7 4h10v16l-5-4-5 4z" fill={filled ? 'currentColor' : 'none'} /></svg>);
export const IconNotes = (p: P) => (<svg {...base(p)}><path d="M5 4h14v16H5z" /><path d="M9 9h6M9 13h6M9 17h3" /></svg>);
export const IconMore = (p: P) => (<svg {...base(p)}><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></svg>);
export const IconUpload = (p: P) => (<svg {...base(p)}><path d="M12 16V4M7 9l5-5 5 5M5 20h14" /></svg>);
export const IconLibrary = (p: P) => (<svg {...base(p)}><path d="M5 4h3v16H5zM10 4h3v16h-3z" /><path d="M15.2 5.2l2.9-.8 3.6 15.4-2.9.7z" /></svg>);
export const IconCompass = (p: P) => (<svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M15.5 8.5l-2 5-5 2 2-5z" /></svg>);
export const IconSettings = (p: P) => (<svg {...base(p)}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>);
export const IconTrash = (p: P) => (<svg {...base(p)}><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" /></svg>);
export const IconHighlight = (p: P) => (<svg {...base(p)}><path d="M4 20h7M14.5 4.5l5 5L11 18H6v-5z" /></svg>);
export const IconCopy = (p: P) => (<svg {...base(p)}><rect x="8" y="8" width="11" height="12" rx="2" /><path d="M5 16V5a1 1 0 011-1h9" /></svg>);
export const IconDownload = (p: P) => (<svg {...base(p)}><path d="M12 4v12M7 11l5 5 5-5M5 20h14" /></svg>);

/** The BookNd mark: an ink drop split like a pen nib. */
export const Mark = (p: P) => (
  <svg viewBox="0 0 56 84" aria-hidden focusable={false} {...p}>
    <path d="M28 2C28 2 2 34 2 53c0 16 12 29 26 29s26-13 26-29C54 34 28 2 28 2Z" fill="currentColor" />
    <circle cx="28" cy="46" r="4.6" fill="var(--bg)" />
    <path d="M28 50v24" stroke="var(--bg)" strokeWidth="3.2" strokeLinecap="round" />
  </svg>
);
