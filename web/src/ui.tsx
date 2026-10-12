import { useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import type { PublicSource, Status } from './types.ts';

/* ---------------- theme ---------------- */

type ThemeChoice = 'system' | 'light' | 'dark';
const THEME_KEY = 'cg-theme';
function readTheme(): ThemeChoice {
  try { const v = localStorage.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}
function applyTheme(t: ThemeChoice) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
applyTheme(readTheme());

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const next = () => {
    const t: ThemeChoice = isDark ? 'light' : 'dark';
    setTheme(t); applyTheme(t);
    try { localStorage.setItem(THEME_KEY, t); } catch { /* per-device convenience only */ }
  };
  return (
    <button type="button" onClick={next} className="grid size-11 place-items-center rounded-full border border-line bg-card text-ink transition-colors hover:border-leaf" aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'} title={isDark ? 'Light theme' : 'Dark theme'}>
      {isDark
        ? <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor" /><g stroke="currentColor" strokeWidth="2" strokeLinecap="round">{[0, 45, 90, 135, 180, 225, 270, 315].map((a) => <line key={a} x1="12" y1="2.5" x2="12" y2="5" transform={`rotate(${a} 12 12)`} />)}</g></svg>
        : <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" fill="currentColor" /></svg>}
    </button>
  );
}

/* ---------------- layout ---------------- */

export function Logo() {
  return (
    <a href="/" className="flex items-center gap-2 font-display text-lg font-bold text-ink no-underline">
      <svg aria-hidden="true" width="30" height="30" viewBox="0 0 32 32">
        <circle cx="16" cy="16" r="15" fill="var(--leaf)" />
        <path d="M5 24c3-1 5-6 11-6s8 5 11 6" stroke="var(--on-leaf)" strokeWidth="2.2" fill="none" strokeLinecap="round" />
        <circle cx="16" cy="11" r="3.2" fill="var(--marker)" />
      </svg>
      Common Ground
    </a>
  );
}

export function Shell({ children, wide = false, bare = false }: { children: ReactNode; wide?: boolean; bare?: boolean }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="no-print">
        <div className={`mx-auto flex w-full items-center justify-between gap-3 px-4 py-3 ${wide ? 'max-w-5xl' : 'max-w-2xl'}`}>
          <Logo />
          <ThemeToggle />
        </div>
      </header>
      <main className={`mx-auto w-full flex-1 px-4 pb-16 ${bare ? '' : 'pt-4'} ${wide ? 'max-w-5xl' : 'max-w-2xl'}`}>{children}</main>
      <footer className="no-print border-t border-line">
        <div className={`mx-auto px-4 py-5 text-sm text-muted ${wide ? 'max-w-5xl' : 'max-w-2xl'}`}>
          Place data © <a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">OpenStreetMap contributors</a>. Routes by <a className="underline" href="https://routing.openstreetmap.de/" target="_blank" rel="noreferrer noopener">FOSSGIS routing</a>.
        </div>
      </footer>
    </div>
  );
}

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger';
export function Button({ variant = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-leaf text-on-leaf hover:bg-leaf-dark disabled:opacity-45 shadow-[0_2px_0_var(--leaf-dark)] active:translate-y-px active:shadow-none',
    secondary: 'border-2 border-leaf text-leaf bg-card hover:bg-leaf-soft disabled:opacity-50',
    quiet: 'text-leaf underline underline-offset-4 decoration-2 hover:decoration-marker px-1',
    danger: 'border-2 border-clay-ink text-clay-ink bg-card hover:bg-clay-soft disabled:opacity-50',
  };
  return <button type="button" className={`min-h-12 rounded-full px-5 py-2 font-bold transition-[background-color,transform,box-shadow] disabled:cursor-not-allowed ${styles[variant]} ${className}`} {...props} />;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`print-card rounded-3xl border border-line bg-card p-5 sm:p-6 ${className}`}>{children}</section>;
}

/** A labelled control. Use `group` when the children contain buttons (a <label> would forward clicks to them). */
export function Field({ label, hint, children, error, group = false }: { label: string; hint?: string; children: ReactNode; error?: string; group?: boolean }) {
  const inner = (
    <>
      <span className="block font-bold">{label}</span>
      {hint && <span className="block text-sm text-muted">{hint}</span>}
      <div className="mt-1.5">{children}</div>
      {error && <span className="mt-1 block text-sm text-clay-ink" role="alert">{error}</span>}
    </>
  );
  return group ? <div role="group" aria-label={label} className="block">{inner}</div> : <label className="block">{inner}</label>;
}

export const inputClass = 'min-h-12 w-full rounded-2xl border-2 border-line bg-field px-4 py-2 text-base text-ink placeholder:text-muted focus:border-leaf focus:outline-none';

const STATUS_STYLE: Record<Status, { cls: string; icon: string }> = {
  pass: { cls: 'bg-leaf-soft text-leaf-dark border-leaf/40', icon: '✓' },
  unknown: { cls: 'bg-amber-soft text-amber-ink border-amber-ink/30', icon: '?' },
  fail: { cls: 'bg-clay-soft text-clay-ink border-clay-ink/30', icon: '✕' },
};

/** Colour-independent: always shows the text label and a symbol. */
export function StatusBadge({ status, label }: { status: Status; label: string }) {
  const s = STATUS_STYLE[status];
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-0.5 text-sm font-bold ${s.cls}`}><span aria-hidden="true">{s.icon}</span>{label}</span>;
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  const cls = { info: 'bg-card border-line', warn: 'bg-amber-soft border-amber-ink/30 text-amber-ink', error: 'bg-clay-soft border-clay-ink/30 text-clay-ink', ok: 'bg-leaf-soft border-leaf/30 text-leaf-dark' }[tone];
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`cg-enter rounded-2xl border p-3.5 text-sm ${cls}`}>{children}</div>;
}

/** Share a link: native share sheet on phones, otherwise copy (falls back to selecting the text on plain-HTTP LAN). */
export function ShareLink({ url, title, text, label = 'Share invite link' }: { url: string; title: string; text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'selected'>('idle');
  const ref = useRef<HTMLInputElement>(null);
  const canShare = typeof navigator.share === 'function';
  const share = async () => {
    if (canShare) { try { await navigator.share({ title, text, url }); return; } catch { /* cancelled or unsupported → copy */ } }
    try { await navigator.clipboard.writeText(url); setState('copied'); } catch { ref.current?.select(); setState('selected'); }
  };
  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input ref={ref} readOnly value={url} className={`${inputClass} text-sm`} onFocus={(e) => e.currentTarget.select()} aria-label="Link" />
        <Button onClick={share} className="shrink-0">{state === 'copied' ? 'Copied' : canShare ? label : 'Copy link'}</Button>
      </div>
      {state === 'selected' && <p className="mt-1 text-sm text-muted">Link selected — press Ctrl+C (or long-press) to copy.</p>}
    </div>
  );
}

export function Sources({ sources }: { sources: PublicSource[] }) {
  if (sources.length === 0) return <p className="text-sm text-muted">No sources recorded.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {sources.map((s) => (
        <li key={s.id}>
          {s.url ? <a className="print-url text-leaf underline" href={s.url} target="_blank" rel="noreferrer noopener">{hostOf(s.url)}</a> : <span>{s.kind === 'firsthand' ? 'Entered by the organiser' : 'Source'}</span>}
          <span className="text-muted"> — {s.confidence}, checked {formatDate(s.checkedAt)}</span>
        </li>
      ))}
    </ul>
  );
}

export const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
export const formatDate = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
export const formatLongDate = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
export function money(amount: number, currency: string) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 }).format(amount); } catch { return `${amount} ${currency}`; }
}
export function currencySymbol(currency: string) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency; } catch { return currency; }
}

/* ---------------- progress ---------------- */

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-1.5" aria-label="Progress">
      {steps.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'now' : 'next';
        return (
          <li key={s} className="flex min-w-0 flex-1 flex-col gap-1.5" aria-current={state === 'now' ? 'step' : undefined}>
            <span className="h-1.5 overflow-hidden rounded-full bg-line">
              <span className={`block h-full rounded-full bg-leaf transition-[width] duration-500 ease-out ${state === 'done' ? 'w-full' : state === 'now' ? 'w-1/2' : 'w-0'}`} />
            </span>
            <span className={`truncate text-xs sm:text-sm ${state === 'now' ? 'font-bold text-ink' : 'text-muted'}`}>
              {state === 'done' && <span aria-hidden="true">✓ </span>}{s}<span className="sr-only"> ({state === 'done' ? 'done' : state === 'now' ? 'current step' : 'coming up'})</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Small explanation of what the local AI does — shown wherever it is used. */
export function GemmaNote({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-block">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-1 rounded-full bg-marker/25 px-2.5 py-0.5 text-xs font-bold text-ink hover:bg-marker/40">
        <span aria-hidden="true">✦</span> Gemma · what's this?
      </button>
      {open && (
        <span className="cg-enter mt-2 block rounded-2xl border border-line bg-card p-3 text-sm text-ink">
          {children ?? <>Gemma is a free, open AI model from Google. Here it runs on the organiser's own computer, so what you type doesn't go to an AI company. It only turns your words into form settings and writes short plan descriptions. It never picks the plan — that's done by plain rules everyone's answers are checked against.</>}
        </span>
      )}
    </span>
  );
}

/** A brief celebratory burst when the whole group confirms. */
export function LeafBurst() {
  const [leaves] = useState(() => Array.from({ length: 14 }, (_, i) => ({ dx: `${(Math.random() - 0.5) * 220}px`, rot: `${(Math.random() - 0.5) * 540}deg`, left: `${8 + i * 6.3}%`, delay: `${Math.random() * 0.35}s`, color: i % 3 === 0 ? 'var(--marker)' : 'var(--leaf)' })));
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 h-40 overflow-hidden" aria-hidden="true">
      {leaves.map((l, i) => (
        <svg key={i} className="cg-leaf absolute top-2" width="14" height="14" viewBox="0 0 10 10" style={{ left: l.left, animationDelay: l.delay, ['--dx' as string]: l.dx, ['--rot' as string]: l.rot }}>
          <path d="M5 0C8 2 9 6 5 10 1 6 2 2 5 0Z" fill={l.color} />
        </svg>
      ))}
    </div>
  );
}

export function useDelayedFlag(ms: number) {
  const [on, setOn] = useState(false);
  useEffect(() => { const t = setTimeout(() => setOn(true), ms); return () => clearTimeout(t); }, [ms]);
  return on;
}
