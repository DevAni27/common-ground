import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { PublicCandidate, SharedOuting } from '../types.ts';
import { Button, Card, Field, inputClass, Notice, StatusBadge } from '../ui.tsx';
import { CandidateCard } from './CandidateCard.tsx';

interface Alternative { kind: string; description: string; candidate: PublicCandidate; patch: Record<string, unknown> | null }
interface ExploreResult { planningVersion: number; explored: number; idea: PublicCandidate | null; alternatives: Alternative[] }
interface VenueRef { id: string; name: string; areaId: string }

const EXTRA_DURATIONS = [30, 45, 60, 90, 120];

export function Explorer({ outingId, outing, busy, act, defaultOpen = false }: { outingId: string; outing: SharedOuting; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void>; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const s = outing.settings;
  const venues: VenueRef[] = outing.places.map((p) => ({ id: p.id, name: p.name, areaId: 'area' }));
  const [idea, setIdea] = useState({ venueId: outing.places[0]?.id ?? '', meetingTime: s.windowStart, durationMinutes: s.durationOptions[0] ?? 60 });
  const [result, setResult] = useState<ExploreResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);


  const run = async (withIdea: boolean) => {
    setLoading(true); setError(null);
    try { setResult(await api<ExploreResult>('POST', `/api/outings/${outingId}/explore`, { expectedVersion: outing.planningVersion, idea: withIdea ? idea : undefined })); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not explore.'); }
    finally { setLoading(false); }
  };

  // When nothing fits, show the nearest workable shared changes straight away.
  useEffect(() => { if (outing.plan?.noMatch) run(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [outing.planningVersion, outing.plan?.noMatch]);

  const apply = (a: Alternative) => act(async () => {
    let v = outing.planningVersion;
    if (a.patch) {
      const r = await api<{ planningVersion: number }>('PATCH', `/api/outings/${outingId}/settings`, { expectedVersion: v, settings: a.patch });
      v = r.planningVersion;
      await api('POST', `/api/outings/${outingId}/plan`, { expectedVersion: v });
    }
    await api('POST', `/api/outings/${outingId}/select`, { expectedVersion: v, candidateKey: a.candidate.key });
    setResult(null);
  });

  const durations = [...new Set([...s.durationOptions, ...EXTRA_DURATIONS])].sort((a, b) => a - b);

  return (
    <Card className="no-print">
      <button type="button" className="flex w-full items-center justify-between text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="font-display text-xl font-bold">What would make it work?</span><span aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`}>⌄</span>
      </button>
      {open && <div className="cg-enter">
      <p className="mt-1 text-sm text-muted">Have a place and time in mind? We re-check it with everyone’s same limits and show small shared changes — earlier, shorter, or another place — that would work. Nobody’s limits are loosened.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="Place">
          <select className={inputClass} value={idea.venueId} onChange={(e) => setIdea({ ...idea, venueId: e.target.value })}>
            {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Field>
        <Field label="Meet at"><input type="time" step={900} className={inputClass} value={idea.meetingTime} onChange={(e) => setIdea({ ...idea, meetingTime: e.target.value })} /></Field>
        <Field label="Minutes outside">
          <select className={inputClass} value={idea.durationMinutes} onChange={(e) => setIdea({ ...idea, durationMinutes: Number(e.target.value) })}>
            {durations.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" disabled={loading || !idea.venueId} onClick={() => run(true)}>{loading ? 'Checking…' : 'Check this idea'}</Button>
        <Button variant="quiet" disabled={loading} onClick={() => run(false)}>Show nearest options outside the current settings</Button>
      </div>
      {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}

      {result && (
        <div className="mt-4 space-y-3" aria-live="polite">
          {result.idea && <CandidateCard c={result.idea} outingId={outingId} isParticipant={false} currency={s.currency} />}
          {result.idea?.status === 'pass' && <Notice tone="ok">This idea already fits everyone's submitted limits.</Notice>}
          {result.alternatives.length > 0 ? (
            <>
              <p className="font-medium">{result.idea ? 'These shared changes would make it work:' : 'Nearest options that would work:'}</p>
              <ul className="space-y-2">
                {result.alternatives.map((a) => (
                  <li key={a.candidate.key + a.kind} className="cg-enter rounded-2xl border-2 border-leaf/40 bg-leaf-soft p-4">
                    <p className="font-bold">{a.description}</p>
                    <p className="text-sm text-muted">{a.candidate.venue.name} · {a.candidate.meetingTime}–{a.candidate.endTime} · {a.candidate.durationMinutes} min</p>
                    <div className="mt-1"><StatusBadge status={a.candidate.status} label={a.candidate.statusLabel} /></div>
                    {a.patch && <p className="mt-1 text-xs text-muted">Needs a shared-settings change ({Object.entries(a.patch).map(([k, v]) => `${k === 'durationOptions' ? 'durations' : k === 'windowStart' ? 'earliest meeting time' : 'latest meeting time'} → ${Array.isArray(v) ? v.join('/') : v}`).join('; ')}). Applying it starts a new plan version and clears approvals.</p>}
                    {outing.viewer.isOrganiser
                      ? <Button className="mt-2" disabled={busy} onClick={() => apply(a)}>{a.patch ? 'Use this change and choose it' : 'Choose this plan'}</Button>
                      : <p className="mt-1 text-sm text-muted">Only the organiser can make this change — you could suggest it in your group chat.</p>}
                  </li>
                ))}
              </ul>
            </>
          ) : result.idea?.status !== 'pass' && (
            <Notice tone="warn">
              No shared change of time, length or place makes this work with the data available (checked {result.explored} combinations between 06:00 and 19:00).
              {result.idea && result.idea.venueNotes.length > 0 && <> Facts that need checking: {result.idea.venueNotes.join(' ')}</>} Anyone can privately review their own requirements if they choose to.
            </Notice>
          )}
        </div>
      )}
      </div>}
    </Card>
  );
}
