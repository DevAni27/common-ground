import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { AppConfig } from './config.ts';
import { HttpError } from './errors.ts';
import type { OutingService, Auth } from './service.ts';
import { ollamaAvailable } from '../ai/ollama.ts';
import { captureError } from '../telemetry.ts';

const ORG_COOKIE = (id: string) => `cg_o_${id}`;
const PART_COOKIE = (id: string) => `cg_p_${id}`;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (/^cg_[op]_[a-z0-9]{8,40}$/.test(k) && /^[A-Za-z0-9_-]{10,200}$/.test(v)) out[k] = v;
  }
  return out;
}

const authFor = (req: Request, id: string): Auth => {
  const c = parseCookies(req.headers.cookie);
  return { organiserToken: c[ORG_COOKIE(id)], participantToken: c[PART_COOKIE(id)] };
};

/** Very small fixed-window limiter, keyed by client address and bucket. */
function rateLimiter(limits: Record<string, number>, windowMs = 60_000) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (bucket: string) => (req: Request, _res: Response, next: NextFunction) => {
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset <= now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > (limits[bucket] ?? 100)) return next(new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please wait a minute.'));
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    next();
  };
}

export function createApp(service: OutingService, config: AppConfig, opts: { staticDir?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const limit = rateLimiter({ capability: 30, mutate: 120, read: 600, ai: 20, geo: 30 });

  app.use((_req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  const api = express.Router();
  api.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use(express.json({ limit: '16kb' }));

  // CSRF/origin protection for cookie-authenticated mutations.
  api.use((req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('x-cg-request') !== '1') return next(new HttpError(403, 'CSRF', 'Missing request header.'));
    const origin = req.get('origin');
    if (origin) {
      const expected = config.publicOrigin ?? `${req.protocol}://${req.get('host')}`;
      if (origin !== expected) return next(new HttpError(403, 'CSRF', 'Cross-origin request refused.'));
    }
    if (req.get('sec-fetch-site') && !['same-origin', 'none'].includes(req.get('sec-fetch-site')!)) return next(new HttpError(403, 'CSRF', 'Cross-site request refused.'));
    next();
  });

  const cookieOpts = (expiresAt: string) => ({
    httpOnly: true, sameSite: 'strict' as const, secure: config.secureCookies, path: '/api', expires: new Date(expiresAt),
  });

  const id = (req: Request) => {
    const v = String(req.params.id ?? '');
    if (!/^[a-z0-9]{8,40}$/.test(v)) throw new HttpError(404, 'NOT_FOUND', 'Not found or no longer available.');
    return v;
  };

  api.get('/health', (_req, res) => {
    res.json({ ok: true, store: service.store.name.split(' (')[0], places: service.geo.name, routing: service.routes.name, publicTransportRouting: service.routes.transitAvailable });
  });

  api.post('/outings', limit('capability'), async (req, res) => {
    const { doc, organiserToken, inviteToken, participantToken } = await service.create(req.body ?? {});
    res.cookie(ORG_COOKIE(doc.id), organiserToken, cookieOpts(doc.expiresAt));
    if (participantToken) res.cookie(PART_COOKIE(doc.id), participantToken, cookieOpts(doc.expiresAt));
    // Capabilities are returned exactly once, as URL fragments (never sent to servers or referrers).
    res.status(201).json({
      outingId: doc.id,
      organiserPath: `/o/${doc.id}#org=${organiserToken}`,
      invitePath: `/o/${doc.id}/join#invite=${inviteToken}`,
      participantPath: participantToken ? `/o/${doc.id}#p=${participantToken}` : null,
    });
  });

  api.post('/session/exchange', limit('capability'), async (req, res) => {
    const body = z.object({ outingId: z.string().regex(/^[a-z0-9]{8,40}$/), role: z.enum(['organiser', 'participant']), token: z.string().min(10).max(200) }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'INVALID', 'Invalid exchange request.');
    const doc = await service.exchange(body.data.outingId, body.data.role, body.data.token);
    res.cookie(body.data.role === 'organiser' ? ORG_COOKIE(doc.id) : PART_COOKIE(doc.id), body.data.token, cookieOpts(doc.expiresAt));
    res.status(204).end();
  });

  api.post('/outings/:id/join', limit('capability'), async (req, res) => {
    const outingId = id(req);
    const r = await service.join(outingId, req.body ?? {}, authFor(req, outingId));
    const doc = await service.load(outingId);
    res.cookie(PART_COOKIE(outingId), r.participantToken, cookieOpts(doc.expiresAt));
    res.status(201).json({ participantPath: `/o/${outingId}#p=${r.participantToken}` });
  });

  api.post('/outings/:id/invite', limit('capability'), async (req, res) => {
    const i = id(req);
    const r = await service.rotateInvite(i, authFor(req, i));
    res.json({ invitePath: `/o/${i}/join#invite=${r.inviteToken}` });
  });
  api.get('/outings/:id', limit('read'), async (req, res) => { const i = id(req); res.json(await service.shared(i, authFor(req, i))); });
  api.get('/outings/:id/me', limit('read'), async (req, res) => { const i = id(req); res.json(await service.me(i, authFor(req, i))); });
  api.put('/outings/:id/me/preferences', limit('mutate'), async (req, res) => { const i = id(req); res.json(await service.savePreferences(i, req.body ?? {}, authFor(req, i))); });
  api.patch('/outings/:id/settings', limit('mutate'), async (req, res) => { const i = id(req); res.json(await service.updateSettings(i, req.body ?? {}, authFor(req, i))); });
  api.post('/outings/:id/close-joining', limit('mutate'), async (req, res) => { const i = id(req); res.json(await service.setJoining(i, req.body ?? {}, authFor(req, i))); });
  api.delete('/outings/:id/participants/:participantId', limit('mutate'), async (req, res) => {
    const i = id(req);
    res.json(await service.removeParticipant(i, String(req.params.participantId), req.body?.expectedVersion, authFor(req, i)));
  });
  api.post('/outings/:id/plan', limit('mutate'), async (req, res) => { const i = id(req); res.json(await service.plan(i, req.body ?? {}, authFor(req, i))); });
  api.post('/outings/:id/me/interpret', limit('ai'), async (req, res) => { const i = id(req); res.json(await service.interpret(i, req.body ?? {}, authFor(req, i))); });
  api.post('/outings/:id/summaries', limit('ai'), async (req, res) => { const i = id(req); res.json(await service.summaries(i, req.body ?? {}, authFor(req, i))); });
  api.get('/ai/status', limit('read'), async (_req, res) => {
    const cfg = service.ollamaConfig();
    if (!cfg) { res.json({ enabled: false, available: false }); return; }
    const r = await ollamaAvailable(cfg);
    // Reports availability and model name only; never the endpoint.
    res.json({ enabled: true, available: r.ok, model: cfg.model, detail: r.ok ? null : (r.models.length ? 'model not pulled' : 'Ollama not reachable') });
  });
  api.post('/outings/:id/explore', limit('mutate'), async (req, res) => { const i = id(req); res.json(await service.explore(i, req.body ?? {}, authFor(req, i))); });
  api.get('/outings/:id/candidates/:candidateKey/me', limit('read'), async (req, res) => {
    const i = id(req);
    res.json(await service.privateCandidate(i, String(req.params.candidateKey), authFor(req, i)));
  });
  api.post('/outings/:id/select', limit('mutate'), async (req, res) => { const i = id(req); res.json(await service.select(i, req.body ?? {}, authFor(req, i))); });
  api.post('/outings/:id/confirm', limit('mutate'), async (req, res) => { const i = id(req); res.json(await service.confirm(i, req.body ?? {}, authFor(req, i))); });
  api.get('/outings/:id/card', limit('read'), async (req, res) => { const i = id(req); res.json(await service.card(i, authFor(req, i))); });
  api.delete('/outings/:id', limit('mutate'), async (req, res) => {
    const i = id(req);
    await service.deleteOuting(i, authFor(req, i));
    res.clearCookie(ORG_COOKIE(i), { path: '/api' });
    res.clearCookie(PART_COOKIE(i), { path: '/api' });
    res.status(204).end();
  });

  // Real-world lookups (OpenStreetMap). Public, rate-limited, no private data.
  api.post('/geo/search', limit('geo'), async (req, res) => { res.json(await service.searchArea(req.body ?? {})); });
  api.post('/geo/places', limit('geo'), async (req, res) => { res.json(await service.nearbyPlaces(req.body ?? {})); });
  api.post('/geo/place-by-name', limit('geo'), async (req, res) => { res.json(await service.placeByName(req.body ?? {})); });
  api.post('/outings/:id/start-planning', limit('mutate'), async (req, res) => { const i = id(req); res.json(await service.startPlanning(i, req.body ?? {}, authFor(req, i))); });
  api.get('/features', limit('read'), async (_req, res) => {
    res.json({ publicTransportRouting: service.routes.transitAvailable, ai: config.aiEnabled ? { model: config.ollamaModel } : null });
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Not found.')));
  api.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.too.large') { res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request too large.' } }); return; }
    if (e?.type === 'entity.parse.failed') { res.status(400).json({ error: { code: 'BAD_JSON', message: 'Invalid JSON.' } }); return; }
    // Log only method + route shape; never bodies, cookies or tokens.
    console.error(`[api] ${req.method} ${req.route?.path ?? 'unknown-route'} failed:`, err instanceof Error ? err.message : 'unknown error');
    captureError(err, `${req.method} ${req.route?.path ?? 'unknown-route'}`);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on the server.' } });
  });

  app.use('/api', api);

  if (opts.staticDir && existsSync(opts.staticDir)) {
    const csp = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    app.use((_req, res, next) => { res.setHeader('Content-Security-Policy', csp); next(); });
    app.use(express.static(opts.staticDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.resolve(opts.staticDir!, 'index.html')));
  }
  return app;
}
