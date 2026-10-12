import { useState, type FormEvent } from 'react';
import { api, ApiError, navigate } from '../api.ts';
import type { AreaResult, OpeningRules, PlaceDraft } from '../types.ts';
import { Button, Card, Field, inputClass, Notice, ShareLink, Shell, Stepper } from '../ui.tsx';

const DAYS = [0, 1, 2, 3, 4, 5, 6];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function nextSaturday() {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  return d.toLocaleDateString('en-CA');
}

function hoursText(r: OpeningRules | null): string {
  if (!r) return 'not mapped';
  if (r.weekly.length === 0) return 'closed every day';
  return r.weekly.map((w) => `${w.days.length === 7 ? 'Daily' : w.days.map((d) => DAY_NAMES[d]).join(', ')} ${w.open === '00:00' && w.close === '23:59' ? 'all day' : `${w.open}–${w.close}`}`).join('; ');
}

type HoursChoice = 'mapped' | 'allday' | 'custom' | 'unknown';
type Tri = 'yes' | 'no' | 'unknown';
interface Review {
  hours: HoursChoice; open: string; close: string;
  fee: 'free' | 'paid' | 'unknown'; feeAmount: string;
  toilet: Tri; stepFree: Tri; seating: Tri;
  meetingPoint: string; walkMinutes: string;
}
const tri = (b: boolean | null): Tri => (b === true ? 'yes' : b === false ? 'no' : 'unknown');
const fromTri = (t: Tri) => (t === 'yes' ? true : t === 'no' ? false : null);

function initialReview(p: PlaceDraft): Review {
  return {
    hours: p.openingHours.parsed ? 'mapped' : 'unknown', open: '06:00', close: '20:00',
    fee: p.fee.value === 0 ? 'free' : p.fee.value !== null ? 'paid' : 'unknown', feeAmount: p.fee.value ? String(p.fee.value) : '',
    toilet: tri(p.toilet), stepFree: tri(p.stepFree), seating: tri(p.seating), meetingPoint: '', walkMinutes: '',
  };
}

function toPlaceInput(p: PlaceDraft, r: Review) {
  const edited: string[] = [];
  let opening: OpeningRules | null = null;
  if (r.hours === 'mapped') opening = p.openingHours.parsed;
  if (r.hours === 'allday') { opening = { weekly: [{ days: DAYS, open: '00:00', close: '23:59' }], exceptions: [] }; edited.push('opening'); }
  if (r.hours === 'custom') { opening = { weekly: [{ days: DAYS, open: r.open, close: r.close }], exceptions: [] }; edited.push('opening'); }
  const fee = r.fee === 'free' ? 0 : r.fee === 'paid' && r.feeAmount !== '' ? Number(r.feeAmount) : null;
  if (fee !== p.fee.value) edited.push('fee');
  if (fromTri(r.toilet) !== p.toilet) edited.push('toilet');
  if (fromTri(r.stepFree) !== p.stepFree) edited.push('stepFree');
  if (fromTri(r.seating) !== p.seating) edited.push('seating');
  if (r.walkMinutes !== '') edited.push('walk');
  if (r.meetingPoint) edited.push('meetingPoint');
  return {
    id: p.id, name: p.name, kind: p.kind, lat: p.lat, lon: p.lon, osmUrl: p.osmUrl, meetingPoint: r.meetingPoint,
    opening, fee, toilet: fromTri(r.toilet), stepFree: fromTri(r.stepFree), seating: fromTri(r.seating),
    walkMinutes: r.walkMinutes === '' ? null : Number(r.walkMinutes), preferenceTags: p.preferenceTags, edited, checked: true,
  };
}

function TriSelect({ label, value, onChange }: { label: string; value: Tri; onChange: (v: Tri) => void }) {
  return (
    <label className="block text-sm">
      <span className="font-bold">{label}</span>
      <select className={`${inputClass} mt-1 min-h-10 py-1 text-sm`} value={value} onChange={(e) => onChange(e.target.value as Tri)}>
        <option value="unknown">Not sure</option><option value="yes">Yes</option><option value="no">No</option>
      </select>
    </label>
  );
}

const CURRENCIES = ['INR', 'EUR', 'USD', 'GBP', 'CAD', 'AUD', 'CHF', 'SGD', 'AED', 'JPY', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'NZD', 'ZAR', 'BRL', 'MXN', 'LKR', 'NPR', 'BDT', 'PKR', 'IDR', 'MYR', 'THB', 'PHP', 'KRW', 'CNY', 'HKD', 'TRY', 'KES', 'NGN'];

export function CreatePage() {
  const [step, setStep] = useState(0);
  const [query, setQuery] = useState('');
  const [areas, setAreas] = useState<AreaResult[] | null>(null);
  const [area, setArea] = useState<AreaResult | null>(null);
  const [radius, setRadius] = useState(2500);
  const [places, setPlaces] = useState<PlaceDraft[] | null>(null);
  const [selected, setSelected] = useState<Record<string, Review>>({});
  const [showAll, setShowAll] = useState(false);
  const [nameQuery, setNameQuery] = useState('');
  const [nameResults, setNameResults] = useState<PlaceDraft[] | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [openDetails, setOpenDetails] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tzDefault = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [when, setWhen] = useState({ title: 'Morning outside', date: nextSaturday(), windowStart: '08:00', windowEnd: '11:00', durations: [60, 90] as number[], expectedCount: 4, nickname: '', going: true, currency: 'EUR', timeZone: tzDefault });
  const [created, setCreated] = useState<{ outingId: string; organiserPath: string; invitePath: string; participantPath: string | null } | null>(null);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setAreas(null);
    try { setAreas((await api<{ results: AreaResult[] }>('POST', '/api/geo/search', { query })).results); }
    catch (err) { setError(err instanceof Error ? err.message : 'Search failed.'); }
    finally { setBusy(false); }
  };

  const chooseArea = async (a: AreaResult, r = radius) => {
    setArea(a); setBusy(true); setError(null); setPlaces(null); setSelected({}); setShowAll(false);
    if (a.currency) setWhen((w) => ({ ...w, currency: a.currency! }));
    setStep(1);
    try { setPlaces((await api<{ places: PlaceDraft[] }>('POST', '/api/geo/places', { lat: a.lat, lon: a.lon, radiusMetres: r })).places); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load places.'); }
    finally { setBusy(false); }
  };

  const findByName = async () => {
    if (!area) return;
    setNameBusy(true); setError(null);
    try { setNameResults((await api<{ places: PlaceDraft[] }>('POST', '/api/geo/place-by-name', { query: nameQuery, lat: area.lat, lon: area.lon })).places); }
    catch (err) { setError(err instanceof Error ? err.message : 'Search failed.'); }
    finally { setNameBusy(false); }
  };
  const addFound = (p: PlaceDraft) => {
    setPlaces((list) => [p, ...(list ?? []).filter((x) => x.id !== p.id)]);
    setSelected((s) => (s[p.id] || Object.keys(s).length >= 8 ? s : { ...s, [p.id]: initialReview(p) }));
    setNameResults(null); setNameQuery('');
  };

  const toggle = (p: PlaceDraft) => setSelected((s) => {
    const n = { ...s };
    if (n[p.id]) delete n[p.id]; else if (Object.keys(n).length < 8) n[p.id] = initialReview(p);
    return n;
  });
  const setReview = (id: string, patch: Partial<Review>) => setSelected((s) => ({ ...s, [id]: { ...s[id]!, ...patch } }));
  const picked = (places ?? []).filter((p) => selected[p.id]);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ outingId: string; organiserPath: string; invitePath: string; participantPath: string | null }>('POST', '/api/outings', {
        settings: { title: when.title, date: when.date, windowStart: when.windowStart, windowEnd: when.windowEnd, durationOptions: [...when.durations].sort((a, b) => a - b), expectedCount: when.expectedCount, currency: when.currency, timeZone: when.timeZone },
        area: { label: area!.label.split(',').slice(0, 3).join(','), lat: area!.lat, lon: area!.lon, countryCode: area!.countryCode },
        places: picked.map((p) => toPlaceInput(p, selected[p.id]!)),
        organiserJoins: when.going,
        organiserNickname: when.nickname || undefined,
      });
      try { localStorage.setItem(`cg-invite-${r.outingId}`, window.location.origin + r.invitePath); } catch { /* convenience only */ }
      setCreated(r); setStep(3);
    } catch (err) {
      setError(err instanceof ApiError && err.details?.length ? `${err.message} (${err.details.map((d) => d.message).join('; ')})` : err instanceof Error ? err.message : 'Could not create the outing.');
    } finally { setBusy(false); }
  };

  const origin = window.location.origin;
  const visible = showAll ? places ?? [] : (places ?? []).slice(0, 10);

  return (
    <Shell>
      <div className="mb-6"><Stepper steps={['Where', 'Places', 'When', 'Share']} current={step} /></div>

      {step === 0 && (
        <div className="cg-step" key="s0">
          <h1 className="font-display text-3xl font-bold">Where do you want to go?</h1>
          <p className="mt-2 text-muted">Type a neighbourhood, town or landmark — anywhere in the world. We’ll find real parks and green spaces nearby.</p>
          <form onSubmit={search} className="mt-5 flex flex-col gap-2 sm:flex-row">
            <input className={inputClass} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. Koregaon Park, Pune" aria-label="Area" autoFocus minLength={2} required />
            <Button type="submit" disabled={busy || query.trim().length < 2} className="shrink-0">{busy ? 'Searching…' : 'Search'}</Button>
          </form>
          {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
          {areas && areas.length === 0 && <div className="mt-3"><Notice tone="warn">Nothing found for that. Try adding the city, e.g. “Indiranagar, Bengaluru”.</Notice></div>}
          {areas && areas.length > 0 && (
            <ul className="mt-4 space-y-2">
              {areas.map((a, i) => (
                <li key={`${a.lat},${a.lon}`} className="cg-enter" style={{ animationDelay: `${i * 40}ms` }}>
                  <button type="button" onClick={() => chooseArea(a)} className="w-full rounded-2xl border-2 border-line bg-card px-4 py-3 text-left hover:border-leaf">
                    <span className="block font-bold">{a.label.split(',')[0]}</span>
                    <span className="block text-sm text-muted">{a.label.split(',').slice(1).join(',').trim()}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {step === 1 && area && (
        <div className="cg-step" key="s1">
          <h1 className="font-display text-3xl font-bold">Pick a few places</h1>
          <p className="mt-2 text-muted">Real outdoor places near <strong className="text-ink">{area.label.split(',')[0]}</strong> from OpenStreetMap. Tap the ones you’d be happy with — 2 to 8 gives the group options.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Search within</span>
            {[1000, 2500, 5000].map((r) => (
              <button key={r} type="button" onClick={() => { setRadius(r); chooseArea(area, r); }} className={`min-h-9 rounded-full border-2 px-3 font-bold ${radius === r ? 'border-leaf bg-leaf text-on-leaf' : 'border-line bg-card'}`}>{r / 1000} km</button>
            ))}
            <Button variant="quiet" onClick={() => setStep(0)}>Change area</Button>
          </div>

          {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
          {busy && <p className="cg-pulse mt-6 text-muted">Looking for parks, gardens and viewpoints… (up to ~15 seconds)</p>}
          {places && places.length === 0 && <div className="mt-4"><Notice tone="warn">No named outdoor places found in this radius. Try a larger radius, or add a place by name below.</Notice></div>}

          <ul className="mt-4 space-y-3">
            {visible.map((p) => {
              const r = selected[p.id];
              return (
                <li key={p.id} className={`rounded-3xl border-2 bg-card transition-colors ${r ? 'border-leaf' : 'border-line'}`}>
                  <label className="flex cursor-pointer items-start gap-3 p-4">
                    <input type="checkbox" className="mt-1 size-5 accent-[var(--leaf)]" checked={!!r} onChange={() => toggle(p)} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-bold">{p.name}</span>
                      <span className="block text-sm text-muted">{p.kind} · {(p.straightLineMetres / 1000).toFixed(1)} km away (straight line) · hours: {hoursText(p.openingHours.parsed)}{p.openingHours.caveat ? ` (${p.openingHours.caveat.toLowerCase()})` : ''}</span>
                    </span>
                    <a href={p.osmUrl} target="_blank" rel="noreferrer noopener" className="shrink-0 text-sm font-bold text-leaf underline" onClick={(e) => e.stopPropagation()}>Map</a>
                  </label>
                  {r && !openDetails[p.id] && (
                    <div className="cg-enter flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-sm">
                      <span className="text-muted">{p.openingHours.parsed && p.fee.value !== null ? 'Hours and fee from OpenStreetMap.' : 'Some details aren’t listed — plans will say “check before you go”.'}</span>
                      <Button variant="quiet" className="min-h-9 text-sm" onClick={() => setOpenDetails((o) => ({ ...o, [p.id]: true }))}>Edit details (optional)</Button>
                    </div>
                  )}
                  {r && openDetails[p.id] && (
                    <div className="cg-enter grid gap-3 border-t border-line px-4 pb-4 pt-3 sm:grid-cols-2">
                      <label className="block text-sm">
                        <span className="font-bold">Opening hours</span>
                        <select className={`${inputClass} mt-1 min-h-10 py-1 text-sm`} value={r.hours} onChange={(e) => setReview(p.id, { hours: e.target.value as HoursChoice })}>
                          {p.openingHours.parsed && <option value="mapped">As mapped: {hoursText(p.openingHours.parsed)}</option>}
                          <option value="allday">Open all day (public space)</option>
                          <option value="custom">Set hours…</option>
                          <option value="unknown">Not sure — say “check before you go”</option>
                        </select>
                        {r.hours === 'custom' && (
                          <span className="mt-2 flex items-center gap-2">
                            <input type="time" className={`${inputClass} min-h-10 py-1 text-sm`} value={r.open} onChange={(e) => setReview(p.id, { open: e.target.value })} aria-label="Opens" />
                            <span>to</span>
                            <input type="time" className={`${inputClass} min-h-10 py-1 text-sm`} value={r.close} onChange={(e) => setReview(p.id, { close: e.target.value })} aria-label="Closes" />
                          </span>
                        )}
                      </label>
                      <label className="block text-sm">
                        <span className="font-bold">Entry fee per person</span>
                        <span className="mt-1 flex gap-2">
                          <select className={`${inputClass} min-h-10 py-1 text-sm`} value={r.fee} onChange={(e) => setReview(p.id, { fee: e.target.value as Review['fee'] })}>
                            <option value="free">Free</option><option value="paid">Costs…</option><option value="unknown">Not sure — assume free</option>
                          </select>
                          {r.fee === 'paid' && <input type="number" min={0} className={`${inputClass} min-h-10 w-28 py-1 text-sm`} value={r.feeAmount} onChange={(e) => setReview(p.id, { feeAmount: e.target.value })} aria-label={`Fee in ${when.currency}`} placeholder={when.currency} />}
                        </span>
                      </label>
                      <div className="grid grid-cols-3 gap-2 sm:col-span-2">
                        <TriSelect label="Toilet" value={r.toilet} onChange={(v) => setReview(p.id, { toilet: v })} />
                        <TriSelect label="Step-free" value={r.stepFree} onChange={(v) => setReview(p.id, { stepFree: v })} />
                        <TriSelect label="Benches" value={r.seating} onChange={(v) => setReview(p.id, { seating: v })} />
                      </div>
                      <label className="block text-sm">
                        <span className="font-bold">Meeting spot (optional)</span>
                        <input className={`${inputClass} mt-1 min-h-10 py-1 text-sm`} value={r.meetingPoint} maxLength={200} onChange={(e) => setReview(p.id, { meetingPoint: e.target.value })} placeholder="e.g. main gate" />
                      </label>
                      <label className="block text-sm">
                        <span className="font-bold">Walking there, roughly (optional)</span>
                        <input type="number" min={0} max={300} className={`${inputClass} mt-1 min-h-10 py-1 text-sm`} value={r.walkMinutes} onChange={(e) => setReview(p.id, { walkMinutes: e.target.value })} placeholder="minutes" />
                      </label>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {places && places.length > 10 && !showAll && <Button variant="quiet" className="mt-2" onClick={() => setShowAll(true)}>Show {places.length - 10} more</Button>}

          <div className="mt-6 rounded-3xl border border-line bg-card p-4">
            <p className="font-bold">Know a place that isn’t listed?</p>
            <p className="text-sm text-muted">Search it by name — it’s looked up on OpenStreetMap.</p>
            <div className="mt-2 flex gap-2">
              <input className={inputClass} value={nameQuery} onChange={(e) => setNameQuery(e.target.value)} placeholder="e.g. Empress Garden" aria-label="Place name"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (nameQuery.trim().length >= 2) findByName(); } }} />
              <Button variant="secondary" className="shrink-0" disabled={nameBusy || nameQuery.trim().length < 2} onClick={findByName}>{nameBusy ? '…' : 'Find'}</Button>
            </div>
            {nameResults && nameResults.length === 0 && <p className="mt-2 text-sm text-muted">Nothing found by that name nearby.</p>}
            {nameResults && nameResults.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {nameResults.map((p) => (
                  <li key={p.id}><button type="button" className="cg-enter w-full rounded-2xl border-2 border-line bg-paper px-3 py-2 text-left text-sm hover:border-leaf" onClick={() => addFound(p)}>
                    <span className="font-bold">{p.name}</span> <span className="text-muted">· {(p.straightLineMetres / 1000).toFixed(1)} km away — add</span>
                  </button></li>
                ))}
              </ul>
            )}
          </div>

          <div className="sticky bottom-0 -mx-4 mt-6 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted">{picked.length} of 8 picked</span>
              <Button disabled={picked.length === 0} onClick={() => setStep(2)}>Next: pick a time</Button>
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <form className="cg-step" key="s2" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <h1 className="font-display text-3xl font-bold">When?</h1>
          <p className="mt-2 text-muted">Give a rough window. Common Ground checks every 15 minutes inside it.</p>
          <Card className="mt-5 space-y-4">
            <Field label="Name of the outing"><input className={inputClass} value={when.title} maxLength={80} required onChange={(e) => setWhen({ ...when, title: e.target.value })} /></Field>
            <Field label="Day"><input type="date" className={inputClass} value={when.date} required onChange={(e) => setWhen({ ...when, date: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Meet from"><input type="time" step={900} className={inputClass} value={when.windowStart} required onChange={(e) => setWhen({ ...when, windowStart: e.target.value })} /></Field>
              <Field label="Meet by"><input type="time" step={900} className={inputClass} value={when.windowEnd} required onChange={(e) => setWhen({ ...when, windowEnd: e.target.value })} /></Field>
            </div>
            <fieldset>
              <legend className="font-bold">How long outside?</legend>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {[30, 45, 60, 90, 120, 180].map((d) => {
                  const on = when.durations.includes(d);
                  return (
                    <button key={d} type="button" aria-pressed={on} onClick={() => setWhen({ ...when, durations: on ? when.durations.filter((x) => x !== d) : [...when.durations, d].slice(-5) })}
                      className={`min-h-11 rounded-full border-2 px-4 font-bold transition-colors ${on ? 'border-leaf bg-leaf text-on-leaf' : 'border-line bg-card'}`}>
                      {d < 60 ? `${d} min` : `${d / 60} h`.replace('.5 h', '½ h')}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <Field group label="How many people, including you?">
              <div className="flex items-center gap-3">
                <Button variant="secondary" className="size-12 px-0" aria-label="Fewer" onClick={() => setWhen({ ...when, expectedCount: Math.max(2, when.expectedCount - 1) })}>−</Button>
                <span className="w-8 text-center font-display text-2xl font-bold" aria-live="polite">{when.expectedCount}</span>
                <Button variant="secondary" className="size-12 px-0" aria-label="More" onClick={() => setWhen({ ...when, expectedCount: Math.min(8, when.expectedCount + 1) })}>+</Button>
              </div>
            </Field>
            <label className="flex items-center gap-2"><input type="checkbox" className="size-5 accent-[var(--leaf)]" checked={when.going} onChange={(e) => setWhen({ ...when, going: e.target.checked })} /><span>I’m going too</span></label>
            {when.going && <Field label="Your first name (optional)" hint="Others only see who has joined — never anyone’s answers."><input className={inputClass} value={when.nickname} maxLength={40} onChange={(e) => setWhen({ ...when, nickname: e.target.value })} /></Field>}
            <details className="text-sm">
              <summary className="cursor-pointer font-bold text-muted">Currency and time zone ({when.currency}, {when.timeZone})</summary>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field label="Currency"><select className={inputClass} value={when.currency} onChange={(e) => setWhen({ ...when, currency: e.target.value })}>{[...new Set([when.currency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}</select></Field>
                <Field label="Time zone of the area"><input className={inputClass} value={when.timeZone} onChange={(e) => setWhen({ ...when, timeZone: e.target.value })} /></Field>
              </div>
            </details>
          </Card>
          {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
          <div className="mt-5 flex items-center justify-between">
            <Button variant="quiet" onClick={() => setStep(1)}>Back</Button>
            <Button type="submit" disabled={busy || when.durations.length === 0}>{busy ? 'Creating…' : 'Create outing'}</Button>
          </div>
        </form>
      )}

      {step === 3 && created && (
        <div className="cg-step" key="s3">
          <div className="cg-pop mb-4 grid size-16 place-items-center rounded-full bg-marker text-3xl" aria-hidden="true">✓</div>
          <h1 className="font-display text-3xl font-bold">Now send this to your group</h1>
          <p className="mt-2 text-muted">Anyone with the link can join until you start planning. Each person answers on their own phone; nobody sees anyone else’s answers.</p>
          <Card className="mt-5">
            <ShareLink url={origin + created.invitePath} title={when.title} text={`Join “${when.title}” — add your limits (takes a minute):`} label="Share invite link" />
          </Card>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button onClick={() => navigate(`/o/${created.outingId}`)}>{created.participantPath ? 'Add my own limits' : 'Go to the outing'}</Button>
          </div>
          <details className="mt-6 text-sm">
            <summary className="cursor-pointer font-bold text-muted">Open this outing on another device</summary>
            <p className="mt-2 text-muted">This is your personal key — it lets you manage the outing{created.participantPath ? ' and answer as yourself' : ''}. Don’t share it.</p>
            <div className="mt-2"><ShareLink url={origin + created.organiserPath + (created.participantPath ? `&p=${created.participantPath.split('#p=')[1]}` : '')} title="My Common Ground key" text="" label="Save my key" /></div>
          </details>
        </div>
      )}
    </Shell>
  );
}
