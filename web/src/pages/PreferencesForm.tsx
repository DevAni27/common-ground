import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api.ts';
import type { AreaResult, Answers } from '../types.ts';
import { Button, Card, currencySymbol, Field, inputClass, Notice } from '../ui.tsx';
import { SuggestSettings } from './SuggestSettings.tsx';

const MODES: Array<[Answers['allowedModes'][number], string, string]> = [['walk', 'Walk', '🚶'], ['public_transport', 'Bus / metro / train', '🚌'], ['own_vehicle', 'My own car or bike', '🚗']];
const FACILITIES: Array<[Answers['requiredFacilities'][number], string]> = [['seating', 'Somewhere to sit'], ['step_free_access', 'Step-free access'], ['toilet', 'A toilet']];
const LIKES: Array<[keyof Answers['softPreferences'], string]> = [['greenery', 'Greenery'], ['quiet', 'Quiet'], ['photography', 'Photos'], ['conversation', 'Chatting'], ['exploring', 'Exploring']];

const BUDGET_DEFAULT: Record<string, number> = { INR: 500, JPY: 2000, KRW: 20000, IDR: 150000, LKR: 3000, PKR: 2000, BDT: 1000, NPR: 1000, PHP: 500, THB: 400, HUF: 5000, CZK: 400, SEK: 200, NOK: 200, DKK: 150, ZAR: 300, MXN: 300, BRL: 80, TRY: 600, KES: 1500, NGN: 10000, CNY: 100, HKD: 150, TWD: 500 };

export function defaultAnswers(currency = 'EUR'): Answers {
  return {
    origin: null, earliestDepartureLocal: '07:00', latestReturnLocal: '13:00', allowedModes: ['public_transport'],
    maxOneWayTravelMinutes: 45, maxTotalCost: BUDGET_DEFAULT[currency] ?? 20, requiredFacilities: [], requireVerifiedLowCrowd: false,
    softPreferences: { greenery: 1, quiet: 1, photography: 1, conversation: 1, exploring: 1 },
    publicTransport: { fareOneWay: null, typicalMinutesToArea: null }, ownVehicle: { costEachWay: null, parkingCost: null },
  };
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={`min-h-12 rounded-full border-2 px-4 font-bold transition-colors ${on ? 'border-leaf bg-leaf text-on-leaf' : 'border-line bg-card text-ink hover:border-leaf'}`}>
      {children}
    </button>
  );
}

const Spark = ({ on }: { on: boolean }) => (on ? <span className="ml-1 text-amber-ink" title="Filled in by Gemma — please check" aria-label="filled in by Gemma">✦</span> : null);

function OriginPicker({ value, onChange }: { value: Answers['origin']; onChange: (v: Answers['origin']) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<AreaResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = async () => {
    setBusy(true); setError(null);
    try { setResults((await api<{ results: AreaResult[] }>('POST', '/api/geo/search', { query: q })).results); } catch (e) { setError(e instanceof Error ? e.message : 'Search failed.'); } finally { setBusy(false); }
  };
  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-2xl border-2 border-leaf bg-leaf-soft px-4 py-3">
        <span className="min-w-0"><span className="block truncate font-bold">{value.label.split(',')[0]}</span><span className="block truncate text-sm text-muted">{value.label.split(',').slice(1, 3).join(',')}</span></span>
        <Button variant="quiet" onClick={() => { onChange(null); setResults(null); }}>Change</Button>
      </div>
    );
  }
  return (
    <div>
      <div className="flex gap-2">
        <input className={inputClass} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Your neighbourhood or a landmark near you" aria-label="Starting place"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (q.trim().length >= 2) search(); } }} />
        <Button variant="secondary" className="shrink-0" disabled={busy || q.trim().length < 2} onClick={search}>{busy ? '…' : 'Find'}</Button>
      </div>
      {error && <div className="mt-2"><Notice tone="error">{error}</Notice></div>}
      {results && results.length === 0 && <p className="mt-2 text-sm text-muted">Nothing found — try adding the city name.</p>}
      {results && results.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {results.slice(0, 5).map((r) => (
            <li key={`${r.lat},${r.lon}`}>
              <button type="button" className="cg-enter w-full rounded-2xl border-2 border-line bg-card px-3 py-2 text-left text-sm hover:border-leaf" onClick={() => onChange({ label: r.label.slice(0, 160), lat: r.lat, lon: r.lon })}>
                <span className="font-bold">{r.label.split(',')[0]}</span><span className="text-muted">{r.label.split(',').slice(1, 3).join(',')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PreferencesForm({ outingId, initial, areaLabel, currency, transitRouting, onSave }: {
  outingId: string; initial: Answers; areaLabel: string; currency: string; transitRouting: boolean;
  onSave: (p: Answers) => Promise<void>;
}) {
  const [p, setP] = useState<Answers>({ ...defaultAnswers(currency), ...initial });
  const [walkLimits, setWalkLimits] = useState(initial.maxTotalWalkMinutes !== undefined || initial.maxContinuousWalkMinutes !== undefined);
  const [more, setMore] = useState(walkLimits || initial.requiredFacilities.length > 0 || initial.requireVerifiedLowCrowd);
  const [filled, setFilled] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sym = currencySymbol(currency);

  const set = <K extends keyof Answers>(k: K, v: Answers[K]) => { setFilled((f) => f.filter((x) => x !== k)); setP((prev) => ({ ...prev, [k]: v })); };
  const toggleIn = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  const num = (v: string) => (v === '' ? 0 : Math.max(0, Math.round(Number(v))));
  const optNum = (v: string) => (v === '' ? null : Math.max(0, Number(v)));
  const g = (field: string) => filled.includes(field);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!p.origin) { setError('Pick where you’re starting from first.'); return; }
    if (p.allowedModes.length === 0) { setError('Pick at least one way you can travel.'); return; }
    setBusy(true); setError(null);
    const out: Answers = { ...p };
    if (!walkLimits) { delete out.maxTotalWalkMinutes; delete out.maxContinuousWalkMinutes; }
    if (!out.allowedModes.includes('public_transport')) delete out.publicTransport;
    if (!out.allowedModes.includes('own_vehicle')) delete out.ownVehicle;
    try { await onSave(out); } catch (err) { setError(err instanceof Error ? err.message : 'Could not save.'); setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <SuggestSettings outingId={outingId} currency={currency} onApply={(patch, fields) => {
        setP((prev) => ({ ...prev, ...patch }));
        setFilled(fields);
        if (patch.maxTotalWalkMinutes !== undefined || patch.maxContinuousWalkMinutes !== undefined) { setWalkLimits(true); setMore(true); }
        if (patch.requiredFacilities?.length) setMore(true);
      }} />

      <Card className="space-y-5">
        <Field group label="Where are you starting from?" hint="A neighbourhood or landmark is enough — not your address. Only you see it; it’s used to work out your travel times.">
          <OriginPicker value={p.origin} onChange={(v) => set('origin', v)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Leave home after`}><span className="flex items-center"><input type="time" className={inputClass} value={p.earliestDepartureLocal} onChange={(e) => set('earliestDepartureLocal', e.target.value)} required /><Spark on={g('earliestDepartureLocal')} /></span></Field>
          <Field label="Be home by"><span className="flex items-center"><input type="time" className={inputClass} value={p.latestReturnLocal} onChange={(e) => set('latestReturnLocal', e.target.value)} required /><Spark on={g('latestReturnLocal')} /></span></Field>
        </div>
      </Card>

      <Card className="space-y-5">
        <fieldset>
          <legend className="font-bold">How can you get there?<Spark on={g('allowedModes')} /></legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {MODES.map(([m, label, icon]) => <Chip key={m} on={p.allowedModes.includes(m)} onClick={() => set('allowedModes', toggleIn(p.allowedModes, m))}><span aria-hidden="true">{icon} </span>{label}</Chip>)}
          </div>
        </fieldset>
        {p.allowedModes.includes('public_transport') && (
          <div className="cg-enter grid gap-3 rounded-2xl bg-leaf-soft p-4 sm:grid-cols-2">
            <Field label={`One-way fare (${sym})`} hint="0 if you have a pass">
              <input type="number" min={0} step="any" className={inputClass} value={p.publicTransport?.fareOneWay ?? ''} onChange={(e) => set('publicTransport', { fareOneWay: optNum(e.target.value), typicalMinutesToArea: p.publicTransport?.typicalMinutesToArea ?? null })} />
            </Field>
            {!transitRouting && (
              <Field label={`Usual time to ${areaLabel.split(',')[0]} by bus/metro`} hint="minutes, door to the area">
                <input type="number" min={1} max={240} className={inputClass} value={p.publicTransport?.typicalMinutesToArea ?? ''} onChange={(e) => set('publicTransport', { fareOneWay: p.publicTransport?.fareOneWay ?? null, typicalMinutesToArea: e.target.value === '' ? null : num(e.target.value) || null })} />
              </Field>
            )}
          </div>
        )}
        {p.allowedModes.includes('own_vehicle') && (
          <div className="cg-enter grid gap-3 rounded-2xl bg-leaf-soft p-4 sm:grid-cols-2">
            <Field label={`Your fuel/toll cost each way (${sym})`}><input type="number" min={0} step="any" className={inputClass} value={p.ownVehicle?.costEachWay ?? ''} onChange={(e) => set('ownVehicle', { costEachWay: optNum(e.target.value), parkingCost: p.ownVehicle?.parkingCost ?? null })} /></Field>
            <Field label={`Parking (${sym})`} hint="0 if free"><input type="number" min={0} step="any" className={inputClass} value={p.ownVehicle?.parkingCost ?? ''} onChange={(e) => set('ownVehicle', { costEachWay: p.ownVehicle?.costEachWay ?? null, parkingCost: optNum(e.target.value) })} /></Field>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Longest trip each way" hint="minutes"><span className="flex items-center"><input type="number" min={0} max={240} className={inputClass} value={p.maxOneWayTravelMinutes} onChange={(e) => set('maxOneWayTravelMinutes', num(e.target.value))} /><Spark on={g('maxOneWayTravelMinutes')} /></span></Field>
          <Field label={`Total budget (${sym})`} hint="travel both ways + entry"><span className="flex items-center"><input type="number" min={0} max={100000} className={inputClass} value={p.maxTotalCost} onChange={(e) => set('maxTotalCost', num(e.target.value))} /><Spark on={g('maxTotalCost')} /></span></Field>
        </div>
      </Card>

      <Card>
        <fieldset>
          <legend className="font-bold">What would make it fun? <span className="font-normal text-muted">(optional — only used to rank plans)</span></legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {LIKES.map(([k, label]) => <Chip key={k} on={p.softPreferences[k] >= 3} onClick={() => set('softPreferences', { ...p.softPreferences, [k]: p.softPreferences[k] >= 3 ? 1 : 3 })}>{label}</Chip>)}
          </div>
        </fieldset>
      </Card>

      <Card>
        <button type="button" className="flex w-full items-center justify-between text-left font-bold" aria-expanded={more} onClick={() => setMore(!more)}>
          <span>Walking or access needs? <span className="font-normal text-muted">(optional)</span></span><span aria-hidden="true" className={`transition-transform ${more ? 'rotate-180' : ''}`}>⌄</span>
        </button>
        {more && (
          <div className="cg-enter mt-4 space-y-4">
            <label className="flex items-center gap-2"><input type="checkbox" className="size-5 accent-[var(--leaf)]" checked={walkLimits} onChange={(e) => { setWalkLimits(e.target.checked); if (e.target.checked) setP((prev) => ({ ...prev, maxTotalWalkMinutes: prev.maxTotalWalkMinutes ?? 60, maxContinuousWalkMinutes: prev.maxContinuousWalkMinutes ?? 20 })); }} /><span>I have walking limits</span></label>
            {walkLimits && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Walking in total" hint="minutes"><span className="flex items-center"><input type="number" min={0} max={600} className={inputClass} value={p.maxTotalWalkMinutes ?? 0} onChange={(e) => set('maxTotalWalkMinutes', num(e.target.value))} /><Spark on={g('maxTotalWalkMinutes')} /></span></Field>
                <Field label="Longest walk without a rest" hint="minutes"><span className="flex items-center"><input type="number" min={0} max={600} className={inputClass} value={p.maxContinuousWalkMinutes ?? 0} onChange={(e) => set('maxContinuousWalkMinutes', num(e.target.value))} /><Spark on={g('maxContinuousWalkMinutes')} /></span></Field>
              </div>
            )}
            <fieldset>
              <legend className="font-bold">The place must have<Spark on={g('requiredFacilities')} /></legend>
              <p className="text-sm text-muted">Only counts if the organiser confirmed it — “not sure” means needs checking, never a yes.</p>
              <div className="mt-2 flex flex-wrap gap-2">{FACILITIES.map(([f, label]) => <Chip key={f} on={p.requiredFacilities.includes(f)} onClick={() => set('requiredFacilities', toggleIn(p.requiredFacilities, f))}>{label}</Chip>)}</div>
            </fieldset>
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5 size-5 accent-[var(--leaf)]" checked={p.requireVerifiedLowCrowd} onChange={(e) => set('requireVerifiedLowCrowd', e.target.checked)} /><span>Quiet is a must <span className="text-sm text-muted">— plans will need someone to confirm the place is calm at that time</span></span></label>
          </div>
        )}
      </Card>

      {filled.length > 0 && <p className="text-sm text-muted"><span className="text-amber-ink">✦</span> = filled in by Gemma. Please check these before saving.</p>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="pt-2">
        <Button type="submit" disabled={busy} className="w-full text-lg">{busy ? 'Checking your routes…' : 'Save my limits'}</Button>
        <p className="mt-1.5 text-center text-xs text-muted">Only you can see these. You can change them until everyone confirms a plan.</p>
      </div>
    </form>
  );
}
