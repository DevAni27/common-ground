import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, navigate, takeFragment } from '../api.ts';
import type { Answers, Me, SharedOuting } from '../types.ts';
import { Button, Card, formatLongDate, GemmaNote, LeafBurst, Notice, ShareLink, Shell, StatusBadge, Stepper } from '../ui.tsx';
import { CandidateCard } from './CandidateCard.tsx';
import { defaultAnswers, PreferencesForm } from './PreferencesForm.tsx';
import { Explorer } from './Explorer.tsx';

const MODE_WORD: Record<string, string> = { walk: 'walking', public_transport: 'by bus/metro', own_vehicle: 'driving' };
type Summary = { text: string; source: 'gemma' | 'template' };

export function OutingPage({ outingId }: { outingId: string }) {
  const [orgToken] = useState(() => takeFragment('org'));
  const [pToken] = useState(() => takeFragment('p'));
  const [outing, setOuting] = useState<SharedOuting | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noAccess, setNoAccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [justSaved, setJustSaved] = useState<string[] | null>(null);
  const [showAllPlans, setShowAllPlans] = useState(false);
  const [summaries, setSummaries] = useState<{ version: number; items: Record<string, Summary> } | null>(null);
  const exchanged = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const o = await api<SharedOuting>('GET', `/api/outings/${outingId}`);
      setOuting(o); setNoAccess(false);
      if (o.viewer.isParticipant) setMe(await api<Me>('GET', `/api/outings/${outingId}/me`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNoAccess(true);
      else setError(e instanceof Error ? e.message : 'Could not load the outing.');
    }
  }, [outingId]);

  useEffect(() => {
    (async () => {
      if (!exchanged.current) {
        exchanged.current = true;
        try {
          if (orgToken) await api('POST', '/api/session/exchange', { outingId, role: 'organiser', token: orgToken });
          if (pToken) await api('POST', '/api/session/exchange', { outingId, role: 'participant', token: pToken });
        } catch { /* invalid link → no-access view */ }
      }
      await refresh();
    })();
  }, [outingId, orgToken, pToken, refresh]);

  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible' && !editing) refresh(); }, 6000);
    return () => clearInterval(t);
  }, [refresh, editing]);

  const planVersion = outing?.plan ? outing.planningVersion : null;
  const hasFitting = !!outing?.plan?.fitting.length;
  useEffect(() => {
    if (planVersion === null || !hasFitting || summaries?.version === planVersion) return;
    setSummaries({ version: planVersion, items: {} });
    api<{ items: Array<{ key: string; text: string; source: Summary['source'] }> }>('POST', `/api/outings/${outingId}/summaries`, { expectedVersion: planVersion })
      .then((r) => setSummaries({ version: planVersion, items: Object.fromEntries(r.items.map((i) => [i.key, { text: i.text, source: i.source }])) }))
      .catch(() => undefined);
  }, [planVersion, hasFitting, outingId, summaries?.version]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await refresh(); } catch (e) {
      setError(e instanceof ApiError && e.code === 'STALE_VERSION' ? 'Something changed a moment ago — the page is up to date now, please try again.' : e instanceof Error ? e.message : 'Something went wrong.');
      await refresh();
    } finally { setBusy(false); }
  };

  if (noAccess) {
    return (
      <Shell>
        <h1 className="mt-6 font-display text-3xl font-bold">This link doesn’t open anything on this device</h1>
        <p className="mt-3 text-muted">Open the invite link your friend sent to join, or your saved personal key if you’ve already joined. The outing may also have ended or been deleted.</p>
        <Button className="mt-6" onClick={() => navigate('/')}>Go to the home page</Button>
      </Shell>
    );
  }
  if (!outing) return <Shell><p className="cg-pulse mt-8 text-muted">{error ?? 'Loading…'}</p></Shell>;

  const s = outing.settings;
  const v = outing.planningVersion;
  const { joined, submitted, expected } = outing.progress;
  const isP = outing.viewer.isParticipant;
  const isO = outing.viewer.isOrganiser;
  const waitingFor = joined - submitted;

  // One current step for this viewer.
  const step = (isP && (!outing.viewer.hasSubmitted || editing)) ? 0
    : outing.cardReady ? 4
    : outing.selection ? 3
    : outing.plan ? 2
    : 1;

  const savePrefs = async (a: Answers) => {
    const put = (expectedVersion: number) => api<{ travelNotes: string[] }>('PUT', `/api/outings/${outingId}/me/preferences`, { expectedVersion, answers: a });
    let r;
    try { r = await put(v); } catch (e) {
      if (e instanceof ApiError && e.code === 'STALE_VERSION') r = await put((await api<SharedOuting>('GET', `/api/outings/${outingId}`)).planningVersion); else throw e;
    }
    setJustSaved(r.travelNotes);
    setEditing(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await refresh();
  };

  const invite = (() => { try { return localStorage.getItem(`cg-invite-${outingId}`); } catch { return null; } })();

  return (
    <Shell wide>
      <div className="mx-auto max-w-2xl">
        <header className="cg-enter">
          <h1 className="font-display text-3xl font-bold sm:text-4xl">{s.title}</h1>
          <p className="mt-1 text-muted">{formatLongDate(s.date)}, meeting between {s.windowStart} and {s.windowEnd} · near {outing.area.label.split(',')[0]}</p>
          <div className="mt-5"><Stepper steps={['Your limits', 'Friends', 'Plans', 'Say yes', 'Go!']} current={step} /></div>
        </header>

        {error && <div className="mt-4"><Notice tone="error">{error}</Notice></div>}

        {/* STEP 0 — your limits */}
        {step === 0 && me && (
          <section className="cg-step mt-8" key="step0">
            <h2 className="font-display text-2xl font-bold">{editing ? 'Change your limits' : 'What works for you?'}</h2>
            <p className="mt-1 text-muted">Only you see your answers. The group only learns which plans work for everyone.</p>
            <div className="mt-5">
              <PreferencesForm outingId={outingId} initial={me.answers ?? defaultAnswers(me.currency)} areaLabel={outing.area.label} currency={me.currency} transitRouting={me.transitRouting} onSave={savePrefs} />
            </div>
            {editing && <Button variant="quiet" className="mt-3" onClick={() => setEditing(false)}>Cancel</Button>}
          </section>
        )}

        {/* STEP 1 — waiting for friends */}
        {step === 1 && (
          <section className="cg-step mt-8 space-y-5" key="step1">
            {justSaved && <Notice tone="ok">Saved. {justSaved.length > 0 ? justSaved.join(' ') : 'Your travel times to each place were worked out from real routes.'}</Notice>}
            <Card>
              <p className="font-display text-5xl font-bold" aria-live="polite">{submitted}<span className="text-2xl text-muted"> of {Math.max(joined, expected)}</span></p>
              <p className="mt-1 text-lg">{submitted === 1 ? 'person has' : 'people have'} added their limits.</p>
              <div className="mt-4 flex gap-1.5" aria-hidden="true">
                {Array.from({ length: Math.max(joined, expected) }, (_, i) => (
                  <span key={i} className={`h-3 flex-1 rounded-full transition-colors duration-500 ${i < submitted ? 'bg-leaf' : i < joined ? 'bg-marker cg-pulse' : 'bg-line'}`} />
                ))}
              </div>
              <p className="mt-3 text-sm text-muted">
                {waitingFor > 0 ? `Waiting for ${waitingFor} ${waitingFor === 1 ? 'person' : 'people'} who joined. ` : ''}
                {joined < expected ? `${expected - joined} more expected to join.` : ''}
              </p>
            </Card>

            {isO && (
              <Card className="space-y-4">
                <h3 className="font-display text-xl font-bold">You’re organising</h3>
                {invite ? <ShareLink url={invite} title={s.title} text={`Join “${s.title}” — add your limits (takes a minute):`} /> : (
                  <Button variant="secondary" disabled={busy} onClick={() => act(async () => { const r = await api<{ invitePath: string }>('POST', `/api/outings/${outingId}/invite`); try { localStorage.setItem(`cg-invite-${outingId}`, window.location.origin + r.invitePath); } catch { /* ignore */ } })}>Get an invite link</Button>
                )}
                <div>
                  <Button disabled={busy || joined < 2 || waitingFor > 0} onClick={() => act(() => api('POST', `/api/outings/${outingId}/start-planning`, { expectedVersion: v }))}>
                    {busy ? 'Finding plans…' : 'Everyone’s in — find plans'}
                  </Button>
                  <p className="mt-2 text-sm text-muted">{joined < 2 ? 'At least two people need to join first.' : waitingFor > 0 ? 'Available once everyone who joined has added their limits.' : 'This stops new people joining and checks every place and time.'}</p>
                </div>
                <OrganiserTools outing={outing} outingId={outingId} busy={busy} act={act} />
              </Card>
            )}

            {isP && me && (
              <Card>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-display text-xl font-bold">Your trips <span className="text-sm font-normal text-muted">(only you see this)</span></h3>
                  <Button variant="quiet" onClick={() => setEditing(true)}>Change my limits</Button>
                </div>
                <ul className="mt-3 space-y-1.5 text-sm">
                  {me.routes.map((r) => (
                    <li key={r.place} className="flex justify-between gap-3 border-b border-line pb-1.5 last:border-0">
                      <span className="font-bold">{r.place}</span>
                      <span className="text-right text-muted">{r.options.length ? r.options.map((o) => `≤ ${o.minutesUpper} min ${MODE_WORD[o.mode] ?? o.mode}`).join(' · ') : 'no route found yet'}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted">Cautious estimates from OpenStreetMap routing — real trips are usually a bit quicker.</p>
              </Card>
            )}
          </section>
        )}

        {/* STEP 2 — plans */}
        {step === 2 && outing.plan && (
          <section className="cg-step mt-8 space-y-4" key="step2">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h2 className="font-display text-2xl font-bold">{outing.plan.noMatch ? 'Nothing fits everyone yet' : outing.plan.fitting.length === 1 ? 'One plan works for everyone' : `${outing.plan.fitting.length} plans work for everyone`}</h2>
              {hasFitting && <GemmaNote>The short description on each plan is written by Gemma, a free open AI model running on the organiser’s computer, using only the place’s facts. Descriptions with made-up details are replaced by a plain one. The plans themselves are chosen by rules, not by the AI.</GemmaNote>}
            </div>
            <p className="text-sm text-muted">Checked {outing.plan.evaluated} place, time and length combinations against everyone’s limits. Best fit for the person with the hardest trip comes first.</p>
            {outing.plan.noMatch
              ? <Notice tone="warn">No combination fits everyone’s limits with what we know. That’s a real answer, not an error — see what small shared change would help below.</Notice>
              : outing.plan.fitting.map((c, i) => (
                <div key={c.key} className="cg-enter" style={{ animationDelay: `${i * 80}ms` }}>
                  <CandidateCard c={c} outingId={outingId} isParticipant={isP} currency={s.currency} summary={summaries?.version === v ? summaries.items[c.key] : undefined}
                    action={isO ? <Button disabled={busy} onClick={() => act(() => api('POST', `/api/outings/${outingId}/select`, { expectedVersion: v, candidateKey: c.key }))}>Choose this plan</Button> : undefined} />
                </div>
              ))}
            {!isO && hasFitting && <p className="text-center text-sm text-muted">The organiser will choose one. Meanwhile you can check your own journey on each.</p>}
            {outing.plan.needsVerification.length > 0 && (
              <details className="rounded-3xl border border-line bg-card p-5">
                <summary className="cursor-pointer font-bold">Could work, but something needs checking ({outing.plan.needsVerification.length})</summary>
                <p className="mt-1 text-sm text-muted">No known problem, but a detail is missing (like opening hours or a fare). These can’t be confirmed until someone fills it in.</p>
                <div className="mt-3 space-y-3">{outing.plan.needsVerification.map((c) => <CandidateCard key={c.key} c={c} outingId={outingId} isParticipant={isP} currency={s.currency} />)}</div>
              </details>
            )}
            <Explorer outingId={outingId} outing={outing} busy={busy} act={act} defaultOpen={outing.plan.noMatch} />
            {isO && <OrganiserTools outing={outing} outingId={outingId} busy={busy} act={act} />}
          </section>
        )}

        {/* STEP 3 — say yes */}
        {step === 3 && outing.selection && (
          <section className="cg-step mt-8 space-y-4" key="step3">
            <h2 className="font-display text-2xl font-bold">Can everyone make this?</h2>
            <CandidateCard c={outing.selection.candidate} outingId={outingId} isParticipant={isP} currency={s.currency} summary={summaries?.version === v ? summaries.items[outing.selection.candidate.key] : undefined} />
            <Card>
              <p className="text-lg"><strong className="font-display text-3xl">{outing.selection.confirmedCount}</strong> of {outing.selection.activeCount} said yes</p>
              <div className="mt-3 h-3 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-leaf transition-[width] duration-700 ease-out" style={{ width: `${(100 * outing.selection.confirmedCount) / outing.selection.activeCount}%` }} /></div>
              {isP && (outing.selection.viewerConfirmed
                ? <p className="cg-pop mt-4 font-bold text-leaf">✓ You’re in. Waiting for the others.</p>
                : <Button className="mt-4 w-full text-lg" disabled={busy} onClick={() => act(() => api('POST', `/api/outings/${outingId}/confirm`, { expectedVersion: v, candidateKey: outing.selection!.candidate.key }))}>I’m in</Button>)}
              {isO && <Button variant="quiet" className="mt-3" disabled={busy} onClick={() => setShowAllPlans(!showAllPlans)}>{showAllPlans ? 'Hide other plans' : 'Choose a different plan'}</Button>}
            </Card>
            {isO && showAllPlans && outing.plan?.fitting.filter((c) => c.key !== outing.selection!.candidate.key).map((c) => (
              <CandidateCard key={c.key} c={c} outingId={outingId} isParticipant={isP} currency={s.currency}
                action={<Button disabled={busy} onClick={() => act(async () => { await api('POST', `/api/outings/${outingId}/select`, { expectedVersion: v, candidateKey: c.key }); setShowAllPlans(false); })}>Choose this instead</Button>} />
            ))}
            {isO && showAllPlans && <p className="text-sm text-muted">Choosing a different plan asks everyone to say yes again.</p>}
          </section>
        )}

        {/* STEP 4 — go! */}
        {step === 4 && outing.selection && (
          <section className="cg-step relative mt-8" key="step4">
            <LeafBurst />
            <Card className="text-center">
              <p className="cg-pop mx-auto grid size-16 place-items-center rounded-full bg-marker text-3xl" aria-hidden="true">✓</p>
              <h2 className="mt-4 font-display text-3xl font-bold">Everyone’s in. Go outside!</h2>
              <p className="mt-2 text-lg">{outing.selection.candidate.venue.name}<br />{formatLongDate(outing.selection.candidate.date)}, {outing.selection.candidate.meetingTime}–{outing.selection.candidate.endTime}</p>
              <p className="mt-1 text-muted">Meet: {outing.selection.candidate.venue.meetingPoint}</p>
              <Button className="mt-6" onClick={() => navigate(`/o/${outingId}/card`)}>Open the outing card</Button>
              <p className="mt-2 text-sm text-muted">Print it or save it as a PDF — it works offline.</p>
            </Card>
          </section>
        )}

        <p className="mt-12 text-center text-xs text-muted">Everyone’s answers are deleted automatically after {new Date(outing.expiresAt).toLocaleDateString()}.</p>
      </div>
    </Shell>
  );
}

function OrganiserTools({ outing, outingId, busy, act }: { outing: SharedOuting; outingId: string; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const v = outing.planningVersion;
  return (
    <details className="rounded-2xl border border-line p-4 text-sm">
      <summary className="cursor-pointer font-bold">Manage outing</summary>
      <div className="mt-3 space-y-4">
        {outing.joiningClosed && <Button variant="secondary" disabled={busy} onClick={() => act(() => api('POST', `/api/outings/${outingId}/close-joining`, { expectedVersion: v, closed: false }))}>Let more people join</Button>}
        {outing.members && outing.members.length > 0 && (
          <div>
            <p className="font-bold">People who joined</p>
            <p className="text-muted">Remove someone only if they’re not coming — this clears plans and confirmations.</p>
            <ul className="mt-2 space-y-2">
              {outing.members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2">
                  <span>{m.nickname}</span>
                  <Button variant="danger" className="min-h-10 px-4 text-sm" disabled={busy} onClick={() => { if (window.confirm(`Remove ${m.nickname} from this outing?`)) act(() => api('DELETE', `/api/outings/${outingId}/participants/${m.id}`, { expectedVersion: v })); }}>Remove</Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <p className="font-bold text-clay-ink">Delete this outing</p>
          <p className="text-muted">Permanently deletes the outing and everyone’s answers.</p>
          <Button className="mt-2 min-h-10 px-4 text-sm" variant="danger" disabled={busy} onClick={() => { if (window.confirm('Delete this outing and all answers? This can’t be undone.')) act(async () => { await api('DELETE', `/api/outings/${outingId}`); navigate('/'); }); }}>Delete outing</Button>
        </div>
      </div>
    </details>
  );
}
