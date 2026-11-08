'use client';
import { useEffect, useState } from 'react';
import { Sheet } from '../Sheet';
import { FONTS, MARGINS, THEMES, type ReaderPrefs } from '@/lib/reader-prefs';
import { getPref, setPref } from '@/lib/db';
import { ink } from '@/lib/ink';

export function TypeSheet({ prefs, onChange, onClose }: { prefs: ReaderPrefs; onChange: (p: Partial<ReaderPrefs>) => void; onClose: () => void }) {
  const [effects, setEffects] = useState(true);
  useEffect(() => void getPref('effects', true).then(setEffects), []);
  return (
    <Sheet title="Reading settings" onClose={onClose} side className="type-sheet">
      <div className="setting">
        <div className="setting-label" id="theme-l">
          Theme
        </div>
        <div className="theme-swatches" role="group" aria-labelledby="theme-l">
          {(Object.keys(THEMES) as ReaderPrefs['theme'][]).map((k) => (
            <button key={k} aria-pressed={prefs.theme === k} onClick={() => onChange({ theme: k })} style={{ background: THEMES[k].bg, color: THEMES[k].text }}>
              <span className="serif">Aa</span>
              <small>{THEMES[k].label}</small>
            </button>
          ))}
        </div>
      </div>
      <div className="setting">
        <label className="setting-label" htmlFor="fs">
          Text size <output htmlFor="fs">{prefs.fontSize}%</output>
        </label>
        <input id="fs" type="range" min={70} max={200} step={5} value={prefs.fontSize} onChange={(e) => onChange({ fontSize: Number(e.target.value) })} data-autofocus />
      </div>
      <div className="setting">
        <label className="setting-label" htmlFor="lh">
          Line spacing <output htmlFor="lh">{prefs.lineHeight.toFixed(1)}</output>
        </label>
        <input id="lh" type="range" min={1.1} max={2.2} step={0.1} value={prefs.lineHeight} onChange={(e) => onChange({ lineHeight: Number(e.target.value) })} />
      </div>
      <div className="setting">
        <div className="setting-label" id="mg-l">
          Margins
        </div>
        <div className="seg" role="group" aria-labelledby="mg-l">
          {(Object.keys(MARGINS) as ReaderPrefs['margin'][]).map((k) => (
            <button key={k} aria-pressed={prefs.margin === k} onClick={() => onChange({ margin: k })}>
              {MARGINS[k].label}
            </button>
          ))}
        </div>
      </div>
      <div className="setting">
        <div className="setting-label" id="ff-l">
          Typeface
        </div>
        <div className="seg" role="group" aria-labelledby="ff-l">
          {(Object.keys(FONTS) as ReaderPrefs['font'][]).map((k) => (
            <button key={k} aria-pressed={prefs.font === k} onClick={() => onChange({ font: k })} style={{ fontFamily: FONTS[k].stack ?? undefined }}>
              {FONTS[k].label}
            </button>
          ))}
        </div>
      </div>
      <div className="setting">
        <label className="switch">
          <span>Liquid-ink effects</span>
          <input
            type="checkbox"
            role="switch"
            checked={effects}
            onChange={async (e) => {
              const on = e.target.checked;
              setEffects(on);
              ink.setDecorative(on);
              document.documentElement.dataset.effects = on ? 'on' : 'off';
              await setPref('effects', on);
            }}
          />
        </label>
      </div>
    </Sheet>
  );
}
