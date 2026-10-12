import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, navigate, randomKey, takeFragment } from '../api.ts';
import { Button, Card, Field, inputClass, Notice, Shell } from '../ui.tsx';

export function JoinPage({ outingId }: { outingId: string }) {
  const [invite] = useState(() => takeFragment('invite'));
  const [joinKey] = useState(randomKey);
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already joined on this device? Go straight to the outing.
  useEffect(() => {
    api<{ viewer: { isParticipant: boolean } }>('GET', `/api/outings/${outingId}`).then((o) => { if (o.viewer.isParticipant) navigate(`/o/${outingId}`); }).catch(() => undefined);
  }, [outingId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const r = await api<{ participantPath: string }>('POST', `/api/outings/${outingId}/join`, { inviteToken: invite, nickname: nickname || undefined, joinKey });
      try { localStorage.setItem(`cg-key-${outingId}`, window.location.origin + r.participantPath); } catch { /* convenience only */ }
      navigate(`/o/${outingId}`);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'ALREADY_JOINED' ? 'You’ve already joined on this device.' : err instanceof Error ? err.message : 'Could not join.');
      if (err instanceof ApiError && err.code === 'ALREADY_JOINED') setTimeout(() => navigate(`/o/${outingId}`), 800);
      setBusy(false);
    }
  };

  if (!invite) {
    return <Shell><div className="mt-6"><Notice tone="warn">This invite link looks incomplete. Ask the organiser to send it again.</Notice></div></Shell>;
  }

  return (
    <Shell>
      <div className="cg-step mt-6">
        <h1 className="font-display text-4xl font-bold">You’re invited outside</h1>
        <p className="mt-3 text-lg text-muted">A friend is planning an outing. Tell the app what works for you — it takes about a minute, and nobody else sees your answers.</p>
        <form onSubmit={submit} className="mt-6">
          <Card className="space-y-4">
            <Field label="Your first name" hint="Optional. The organiser sees who joined, never what anyone answered.">
              <input className={inputClass} value={nickname} maxLength={40} onChange={(e) => setNickname(e.target.value)} autoComplete="given-name" autoFocus />
            </Field>
            {error && <Notice tone="error">{error}</Notice>}
            <Button type="submit" disabled={busy} className="w-full text-lg">{busy ? 'Joining…' : 'Join and add my limits'}</Button>
          </Card>
        </form>
      </div>
    </Shell>
  );
}
