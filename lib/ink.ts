/**
 * Liquid Ink motion engine.
 *
 * Independent of the reader: it only paints a canvas overlay and never owns reading state,
 * blocks navigation or draws book text. Every transition is interruptible and stops
 * drawing the moment it ends (no idle animation loop).
 */

export type InkRect = { x: number; y: number; width: number; height: number };
export type InkKind = 'open' | 'close' | 'ripple';
export interface InkRequest {
  kind: InkKind;
  origin?: InkRect;
  color?: string;
}

type Listener = (req: InkRequest) => void;
const listeners = new Set<Listener>();
let decorativeEnabled = true;

export const ink = {
  subscribe(fn: Listener) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
  /** Fire-and-forget: callers never wait for ink. */
  play(req: InkRequest) {
    if (!ink.enabled()) return;
    listeners.forEach((l) => l(req));
  },
  setDecorative(on: boolean) {
    decorativeEnabled = on;
  },
  enabled() {
    if (!decorativeEnabled || typeof window === 'undefined') return false;
    return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  },
};

export function rectOf(el: Element | null | undefined): InkRect | undefined {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** Deterministic pseudo-random numbers, so a given transition always looks considered, never noisy. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

interface Blob {
  x: number;
  y: number;
  r: number;
  delay: number;
  lobes: number;
  phase: number;
  wobble: number;
}

/** A soft-edged organic blob: a circle whose radius breathes with a few low-frequency lobes. */
function drawBlob(ctx: CanvasRenderingContext2D, b: Blob, radius: number, t: number) {
  if (radius <= 0.5) return;
  const steps = 28;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const k = 1 + b.wobble * Math.sin(a * b.lobes + b.phase + t * 2.2) + b.wobble * 0.5 * Math.sin(a * (b.lobes + 2) - b.phase);
    const x = b.x + Math.cos(a) * radius * k;
    const y = b.y + Math.sin(a) * radius * k;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

export interface InkRun {
  cancel(): void;
  done: Promise<void>;
}

/**
 * Runs one transition on a canvas. Drawn at reduced resolution and upscaled by CSS:
 * the softness is part of the look and keeps the fill cost low on phones.
 */
export function runInk(canvas: HTMLCanvasElement, req: InkRequest): InkRun {
  const ctx = canvas.getContext('2d');
  const W = window.innerWidth;
  const H = window.innerHeight;
  const scale = Math.min(window.devicePixelRatio || 1, 2) * 0.5;
  canvas.width = Math.ceil(W * scale);
  canvas.height = Math.ceil(H * scale);
  const color = req.color ?? '#242522';
  const o = req.origin ?? { x: W / 2 - 1, y: H / 2 - 1, width: 2, height: 2 };
  const cx = o.x + o.width / 2;
  const cy = o.y + o.height / 2;
  const far = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
  const rand = rng(Math.round(cx * 31 + cy * 17 + W));

  const ripple = req.kind === 'ripple';
  const count = ripple ? 6 : 13;
  const blobs: Blob[] = Array.from({ length: count }, (_, i) => ({
    x: cx + (rand() - 0.5) * o.width * 0.9,
    y: cy + (rand() - 0.5) * o.height * 0.9,
    r: i === 0 ? 1 : 0.35 + rand() * 0.55,
    delay: i === 0 ? 0 : rand() * 0.22,
    lobes: 2 + Math.floor(rand() * 4),
    phase: rand() * Math.PI * 2,
    wobble: 0.04 + rand() * 0.07,
  }));

  const timing = ripple
    ? { grow: 520, hold: 0, fade: 380 }
    : req.kind === 'open'
      ? { grow: 560, hold: 60, fade: 340 }
      : { grow: 520, hold: 40, fade: 0 };
  const total = timing.grow + timing.hold + timing.fade;
  const maxR = ripple ? Math.max(o.width, o.height) * 0.9 : far * 1.15;

  let raf = 0;
  let cancelled = false;
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const start = performance.now();

  const finish = () => {
    cancelAnimationFrame(raf);
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.opacity = '0';
    resolve();
  };

  const frame = (now: number) => {
    if (cancelled || !ctx) return finish();
    const el = now - start;
    const t = el / 1000;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = color;

    if (req.kind === 'close') {
      // Ink gathers inward toward the book: a full field contracting to its cover.
      const flood = 140;
      const p = easeInOutSine(clamp01((el - flood) / timing.grow));
      canvas.style.opacity = String(Math.min(clamp01(el / flood), 1 - clamp01((el - flood - timing.grow) / 160)));
      for (const b of blobs) drawBlob(ctx, b, maxR * b.r * (1 - p), t);
      if (p < 1) {
        // a dense core that lingers, as ink pooling into the page
        ctx.globalAlpha = 1 - p;
        drawBlob(ctx, { ...blobs[0], r: 1 }, Math.max(o.width, o.height) * 0.6, t);
        ctx.globalAlpha = 1;
      }
    } else {
      const fadeP = clamp01((el - timing.grow - timing.hold) / Math.max(1, timing.fade));
      canvas.style.opacity = String(ripple ? 0.18 * (1 - fadeP) : 1 - easeInOutSine(fadeP));
      for (const b of blobs) {
        const p = easeOutCubic(clamp01((el / timing.grow - b.delay) / (1 - b.delay)));
        drawBlob(ctx, b, maxR * b.r * p, t);
      }
    }
    if (el >= total + (req.kind === 'close' ? 300 : 0)) return finish();
    raf = requestAnimationFrame(frame);
  };

  canvas.style.opacity = req.kind === 'close' ? '0' : '1';
  raf = requestAnimationFrame(frame);
  return {
    cancel() {
      cancelled = true;
      finish();
    },
    done,
  };
}
