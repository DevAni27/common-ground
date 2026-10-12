import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { Card as CardData } from '../types.ts';
import { Button, Card, formatDate, formatLongDate, Notice, Shell, Sources } from '../ui.tsx';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Standalone, offline-readable card. Built only from the public card DTO: no tokens, no private answers. */
export function cardToHtml(c: CardData): string {
  const li = (items: string[]) => items.map((x) => `<li>${x}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(c.title)} — outing card</title>
<style>body{font-family:system-ui,Segoe UI,sans-serif;max-width:40rem;margin:1.5rem auto;padding:0 1rem;color:#17261d;background:#eef3ec;line-height:1.5}h1{color:#22513a;margin-bottom:.2rem}section{background:#fff;border:1px solid #cfdacf;border-radius:18px;padding:1rem;margin:1rem 0}.muted{color:#56665c;font-size:.9rem}a{color:#2f6b46}</style></head><body>
<h1>${esc(c.title)}</h1><p><strong>${esc(formatLongDate(c.date))}</strong> · ${esc(c.meetingTime)}–${esc(c.endTime)}</p>
<section><h2>${esc(c.venue.name)}</h2><p>Meet: ${esc(c.venue.meetingPoint)}</p>${c.venue.mapUrl ? `<p><a href="${esc(c.venue.mapUrl)}">${esc(c.venue.mapUrl)}</a></p>` : ''}
<ul>${li(c.schedule.map((s) => `<strong>${esc(s.time)}</strong> ${esc(s.text)}`))}</ul></section>
${c.checkBeforeYouGo.length ? `<section><h3>Check before you go</h3><ul>${li(c.checkBeforeYouGo.map(esc))}</ul></section>` : ''}<section><h3>Facts</h3><ul>${li(c.facts.map((f) => `${esc(f.label)}: ${esc(f.text)}`))}</ul>${c.excludedOptionalCosts.length ? `<p class="muted">Not included (optional): ${esc(c.excludedOptionalCosts.join('; '))}</p>` : ''}</section>
<section><h3>Planning assumptions</h3><ul>${li(c.assumptions.map(esc))}</ul></section>
<section><h3>Sources</h3><ul>${li(c.sources.map((s) => `${s.url ? `<a href="${esc(s.url)}">${esc(s.url)}</a>` : esc(s.kind)} — ${esc(s.confidence)}, checked ${esc(formatDate(s.checkedAt))}`))}</ul></section>
<p class="muted">Confirmed by ${esc(c.confirmedBy)} · Made with Common Ground · Place data © OpenStreetMap contributors</p></body></html>`;
}

export function cardToText(c: CardData): string {
  return [
    `${c.title}`, `${formatLongDate(c.date)}, ${c.meetingTime}–${c.endTime}`, '',
    `${c.venue.name}`, `Meet: ${c.venue.meetingPoint}`, ...(c.venue.mapUrl ? [c.venue.mapUrl] : []), '',
    ...c.schedule.map((s) => `${s.time}  ${s.text}`), '',
    'Facts:', ...c.facts.map((f) => `- ${f.label}: ${f.text}`), '',
    'Planning assumptions:', ...c.assumptions.map((a) => `- ${a}`), '',
    'Sources:', ...c.sources.map((s) => `- ${s.url ?? s.kind} (${s.confidence}, checked ${formatDate(s.checkedAt)})`), '',
    `Confirmed by ${c.confirmedBy}.`,
  ].join('\n');
}

function download(name: string, type: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CardPage({ outingId }: { outingId: string }) {
  const [card, setCard] = useState<CardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<CardData>('GET', `/api/outings/${outingId}/card`).then(setCard).catch((e) => setError(e instanceof Error ? e.message : 'Could not load the card.')); }, [outingId]);

  if (error) return <Shell><Notice tone="warn">{error}</Notice><p className="mt-3"><a className="font-bold text-leaf underline" href={`/o/${outingId}`}>Back to the outing</a></p></Shell>;
  if (!card) return <Shell><p className="text-muted">Loading…</p></Shell>;
  const slug = card.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'outing';

  return (
    <Shell>
      <div className="no-print mb-4 flex flex-wrap gap-2">
        <Button onClick={() => window.print()}>Print / Save as PDF</Button>
        <Button variant="secondary" onClick={() => download(`${slug}-card.html`, 'text/html', cardToHtml(card))}>Download card (HTML)</Button>
        <Button variant="secondary" onClick={() => download(`${slug}-card.txt`, 'text/plain', cardToText(card))}>Download as text</Button>
        <a className="self-center font-bold text-leaf underline" href={`/o/${outingId}`}>Back to the outing</a>
      </div>
      <h1 className="font-display text-4xl font-bold">{card.title}</h1>
      <p className="mt-1 text-lg"><strong>{formatLongDate(card.date)}</strong> · {card.meetingTime}–{card.endTime}</p>
      <Card className="mt-4">
        <h2 className="font-display text-2xl font-bold">{card.venue.name}</h2>
        <p className="mt-1"><span className="text-muted">Meet:</span> {card.venue.meetingPoint}</p>
        {card.venue.mapUrl && <p><a className="print-url font-bold text-leaf underline" href={card.venue.mapUrl} target="_blank" rel="noreferrer noopener">Open map</a></p>}
        <ol className="mt-3 space-y-1">{card.schedule.map((s, i) => <li key={i}><strong className="tabular-nums">{s.time}</strong> {s.text}</li>)}</ol>
      </Card>
      {card.checkBeforeYouGo.length > 0 && <div className="mt-4"><Notice tone="warn"><strong>Check before you go:</strong> {card.checkBeforeYouGo.join(' ')}</Notice></div>}
      <Card className="mt-4">
        <h3 className="font-bold">Facts</h3>
        <ul className="mt-1 space-y-0.5 text-sm">{card.facts.map((f) => <li key={f.label}><span className="text-muted">{f.label}:</span> {f.text}</li>)}</ul>
        {card.excludedOptionalCosts.length > 0 && <p className="mt-2 text-sm text-muted">Not included (optional): {card.excludedOptionalCosts.join('; ')}</p>}
      </Card>
      <Card className="mt-4">
        <h3 className="font-bold">Planning assumptions</h3>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">{card.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
      </Card>
      <Card className="mt-4"><h3 className="mb-1 font-bold">Sources</h3><Sources sources={card.sources} /></Card>
      <p className="mt-4 text-sm text-muted">Confirmed by {card.confirmedBy}. Your personal journey details are on the outing page and are not part of this card.</p>
    </Shell>
  );
}
