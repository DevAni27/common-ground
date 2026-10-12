import { useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import type { PrivateJourney, PublicCandidate } from '../types.ts';
import { Button, Card, money, Notice, Sources, StatusBadge } from '../ui.tsx';

const MODE_LABEL: Record<string, string> = { walk: 'Walking', public_transport: 'Bus / metro / train', own_vehicle: 'Your own vehicle' };

export function PrivateJourneyPanel({ outingId, candidateKey, currency }: { outingId: string; candidateKey: string; currency: string }) {
  const [data, setData] = useState<PrivateJourney | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || data) return;
    try { setData(await api<PrivateJourney>('GET', `/api/outings/${outingId}/candidates/${encodeURIComponent(candidateKey)}/me`)); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load.'); }
  };
  return (
    <div className="no-print">
      <Button variant="quiet" onClick={toggle} aria-expanded={open}>{open ? 'Hide my journey' : 'My journey and cost'}</Button>
      {open && error && <Notice tone="error">{error}</Notice>}
      {open && data && (
        <div className="cg-enter mt-2 rounded-2xl border-2 border-dashed border-leaf/50 bg-paper p-4 text-sm">
          <p className="text-xs text-muted">Only you can see this.</p>
          <div className="mt-1"><StatusBadge status={data.status} label={data.status === 'pass' ? 'Works for you' : data.status === 'fail' ? 'Doesn’t work for you' : 'Needs checking for you'} /></div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1">
            <dt className="text-muted">Travel</dt><dd>{data.mode ? MODE_LABEL[data.mode] ?? data.mode : '—'}</dd>
            <dt className="text-muted">Leave by</dt><dd>{data.leaveBy ?? 'unknown'}</dd>
            <dt className="text-muted">Home by (latest)</dt><dd>{data.homeBy ?? 'unknown'}</dd>
            <dt className="text-muted">Trip there / back</dt><dd>up to {data.outboundMinutesUpper ?? '?'} / {data.returnMinutesUpper ?? '?'} min</dd>
            <dt className="text-muted">Your cost</dt><dd>{data.costUpper === null ? 'unknown' : `up to ${money(data.costUpper, currency)}`}</dd>
          </dl>
          {data.checks.some((c) => c.status !== 'pass') && (
            <ul className="mt-3 space-y-1">
              {data.checks.filter((c) => c.status !== 'pass').map((c, i) => <li key={i} className="flex gap-2"><span aria-hidden="true">{c.status === 'fail' ? '✕' : '?'}</span><span><span className="font-bold">{c.label}</span> — {c.text}</span></li>)}
            </ul>
          )}
          {data.limitations.length > 0 && <p className="mt-2 text-muted">{[...new Set(data.limitations)].join(' ')}</p>}
        </div>
      )}
    </div>
  );
}

export function CandidateCard({ c, outingId, isParticipant, action, summary, currency }: { c: PublicCandidate; outingId: string; isParticipant: boolean; action?: ReactNode; summary?: { text: string; source: 'gemma' | 'template' }; currency: string }) {
  const [showFacts, setShowFacts] = useState(false);
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-display text-xl font-bold">{c.venue.name}</h3>
          <p className="font-bold text-leaf">{c.meetingTime}–{c.endTime} <span className="font-normal text-muted">· {c.durationMinutes} min outside</span></p>
        </div>
        <StatusBadge status={c.status} label={c.status === 'pass' ? 'Works for everyone' : c.statusLabel} />
      </div>
      {summary && (
        <p className="cg-enter mt-3">
          {summary.text}
          {summary.source === 'gemma' && <span className="ml-1.5 align-middle text-xs font-bold text-amber-ink" title="Written by Gemma from this place’s facts">✦ Gemma</span>}
        </p>
      )}
      <p className="mt-2 text-sm"><span className="text-muted">Meet:</span> {c.venue.meetingPoint}{c.venue.mapUrl && <> · <a className="font-bold text-leaf underline" href={c.venue.mapUrl} target="_blank" rel="noreferrer noopener">map</a></>}</p>
      {c.sharedPreferences.length > 0 && <p className="mt-1 text-sm"><span className="text-muted">Good for:</span> {c.sharedPreferences.join(', ')}</p>}
      {c.assumptions.length > 0 && <p className="mt-1 text-sm text-amber-ink">Check before you go: {c.assumptions.join(' ')}</p>}
      {c.venueNotes.map((n) => <p key={n} className="mt-1 text-sm text-amber-ink">{n}</p>)}
      {c.groupNote && <p className="mt-1 text-sm text-amber-ink">{c.groupNote}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-3">
        <Button variant="quiet" onClick={() => setShowFacts(!showFacts)} aria-expanded={showFacts}>{showFacts ? 'Hide details' : 'Place details'}</Button>
        {isParticipant && <PrivateJourneyPanel outingId={outingId} candidateKey={c.key} currency={currency} />}
      </div>
      {showFacts && (
        <div className="cg-enter mt-2 space-y-2 text-sm">
          <ul className="space-y-0.5">{c.facts.map((f) => <li key={f.label}><span className="text-muted">{f.label}:</span> {f.text}</li>)}</ul>
          <Sources sources={c.sources} />
        </div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </Card>
  );
}
