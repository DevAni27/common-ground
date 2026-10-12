import { useState } from 'react';
import { api } from '../api.ts';
import type { Answers } from '../types.ts';
import { Button, GemmaNote, inputClass, Notice } from '../ui.tsx';

interface Suggestion { field: string; label: string; value: unknown; display: string; quote: string }
type Result =
  | { source: 'gemma' | 'rules'; suggestions: Suggestion[]; questions: string[]; rejectedFields: string[]; metrics: { elapsedMs: number } | null }
  | { source: 'unavailable'; reason: string };

/** "Say it your way": local Gemma turns free text into form settings, which the person reviews before saving. */
export function SuggestSettings({ outingId, currency, onApply }: { outingId: string; currency: string; onApply: (p: Partial<Answers>, filled: string[]) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api<Result>('POST', `/api/outings/${outingId}/me/interpret`, { text });
      setResult(r);
      if (r.source !== 'unavailable' && r.suggestions.length > 0) {
        const patch: Partial<Answers> = {};
        for (const s of r.suggestions) {
          if (s.field === 'softPreferences') {
            const likes = s.value as Array<keyof Answers['softPreferences']>;
            patch.softPreferences = { greenery: 1, quiet: 1, photography: 1, conversation: 1, exploring: 1, ...Object.fromEntries(likes.map((l) => [l, 3])) } as Answers['softPreferences'];
          } else (patch as Record<string, unknown>)[s.field] = s.value;
        }
        onApply(patch, r.suggestions.map((s) => s.field));
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not get suggestions.'); } finally { setBusy(false); }
  };

  return (
    <div className="rounded-3xl border-2 border-dashed border-marker bg-marker/10 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-xl font-bold">Say it your way</h3>
        <GemmaNote />
      </div>
      <p className="mt-1 text-sm text-muted">Type your limits like you’d text a friend. Gemma fills in the form below for you — check it, change anything, then save.</p>
      <textarea className={`${inputClass} mt-3 min-h-24`} maxLength={600} value={text} onChange={(e) => setText(e.target.value)}
        placeholder={`e.g. I need to be back by 1 pm, can spend about ${currency === 'INR' ? '300' : '15'} in total, bus or metro is fine, I can’t walk more than 15 minutes at a time.`} aria-label="Your limits in your own words" />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button disabled={busy || text.trim().length < 3} onClick={ask}>{busy ? 'Gemma is reading…' : 'Fill the form for me'}</Button>
        {busy && <span className="cg-pulse text-sm text-muted">Running on the organiser’s computer — a few seconds</span>}
      </div>
      {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
      {result?.source === 'unavailable' && <div className="mt-3"><Notice tone="warn">Gemma isn’t available right now ({result.reason === 'AI_DISABLED' ? 'turned off on this server' : 'the local model didn’t respond'}). Just use the form below — it works the same.</Notice></div>}
      {result && result.source !== 'unavailable' && (
        <div className="cg-enter mt-3 space-y-2">
          {result.suggestions.length > 0
            ? <Notice tone="ok">Filled in {result.suggestions.length} {result.suggestions.length === 1 ? 'setting' : 'settings'} below (marked ✦). {result.suggestions.filter((s) => s.quote).map((s) => `${s.label}: ${s.display} — from “${s.quote}”`).join(' · ')}</Notice>
            : <Notice>Nothing could be read confidently from that. Please use the form.</Notice>}
          {result.questions.length > 0 && (
            <div className="rounded-2xl bg-amber-soft p-3 text-sm text-amber-ink">
              <p className="font-bold">Please set these yourself:</p>
              <ul className="mt-1 list-disc pl-5">{result.questions.map((q) => <li key={q}>{q}</li>)}</ul>
            </div>
          )}
          <p className="text-xs text-muted">{result.source === 'rules' ? 'Gemma didn’t respond, so only clearly stated times and amounts were read.' : `Took ${((result.metrics?.elapsedMs ?? 0) / 1000).toFixed(1)} s.`} Anything that couldn’t be matched to your exact words was left out.</p>
        </div>
      )}
    </div>
  );
}
