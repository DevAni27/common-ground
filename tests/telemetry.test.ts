/**
 * Sends real Sentry SDK envelopes to a LOCAL fake ingest endpoint and inspects
 * them. This verifies what would leave the machine; it is not a hosted Sentry run.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { flushTelemetry, initTelemetry, scrubAttributes } from '../src/telemetry.ts';
import { loadConfig } from '../src/server/config.ts';
import { answers, FakeGeo, FakeRoutes, outingBody } from './fixtures/fake-geo.ts';
import { OutingService } from '../src/server/service.ts';
import { MemoryStore } from '../src/server/store.ts';
import { createPlanningEngine } from '../src/workflows/planning.ts';

const bodies: string[] = [];
const ingest = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let buf = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip') buf = gunzipSync(buf);
    bodies.push(buf.toString('utf8'));
    res.writeHead(200).end('{}');
  });
});
const fakeOllama = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const keys = [...b.matchAll(/\\"key\\": \\"([^\\"]+)\\"/g)].map((m) => m[1]);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: { content: JSON.stringify({ summaries: keys.map((k) => ({ key: k, text: 'A short green walk.' })) }) }, prompt_eval_count: 321, eval_count: 54 }));
  });
});
afterAll(() => { ingest.close(); fakeOllama.close(); });

describe('telemetry sanitisation', () => {
  it('drops non-allow-listed attributes and token-like strings', () => {
    expect(scrubAttributes({ prompt: 'secret', 'cg.status': 'ok', 'gen_ai.request.model': 'gemma3:4b', 'cg.failure': 'x'.repeat(40) }))
      .toEqual({ 'cg.status': 'ok', 'gen_ai.request.model': 'gemma3:4b', 'cg.failure': '[redacted]' });
  });

  it('sends spans with timings and token counts but no private data, prompts or capabilities', async () => {
    await new Promise<void>((r) => ingest.listen(0, '127.0.0.1', () => r()));
    await new Promise<void>((r) => fakeOllama.listen(0, '127.0.0.1', () => r()));
    const ingestPort = (ingest.address() as AddressInfo).port;
    const ollamaPort = (fakeOllama.address() as AddressInfo).port;
    expect(await initTelemetry(`http://abc123@127.0.0.1:${ingestPort}/1`, 'test')).toBe(true);

    const NOW = new Date('2026-10-09T06:30:00Z');
    const config = { ...loadConfig({}), timeZone: 'Asia/Kolkata', ollamaBaseUrl: `http://127.0.0.1:${ollamaPort}` };
    const service = new OutingService(new MemoryStore(), new FakeGeo(), new FakeRoutes(), config, () => NOW);
    service.planning = createPlanningEngine({ now: () => NOW.getTime(), ollama: () => service.ollamaConfig(), runLogFile: null });
    const { doc, organiserToken, inviteToken } = await service.create({ ...outingBody({ title: 'Private Title', date: '2026-10-18', windowStart: '09:00', windowEnd: '10:00', durationOptions: [60], expectedCount: 2 }), organiserJoins: false });
    const tokens = [organiserToken, inviteToken];
    for (let i = 0; i < 2; i++) {
      const j = await service.join(doc.id, { inviteToken, nickname: `Nick${i}Private`, joinKey: `tel-key-${i}-xx` }, {});
      tokens.push(j.participantToken);
      await service.savePreferences(doc.id, { expectedVersion: (await service.load(doc.id)).planningVersion, answers: answers({
        origin: 'East', earliestDepartureLocal: '07:00', latestReturnLocal: '16:41', allowedModes: ['public_transport'],
        maxOneWayTravelMinutes: 59, maxTotalCost: 48613, requiredFacilities: [], requireVerifiedLowCrowd: false,
        softPreferences: { greenery: 2, quiet: 0, photography: 0, conversation: 0, exploring: 0 },
      }) }, { participantToken: j.participantToken });
    }
    let v = (await service.load(doc.id)).planningVersion;
    await service.setJoining(doc.id, { expectedVersion: v, closed: true }, { organiserToken });
    v = (await service.load(doc.id)).planningVersion;
    await service.plan(doc.id, { expectedVersion: v }, { organiserToken });
    await flushTelemetry();
    await new Promise((r) => setTimeout(r, 300));

    const all = bodies.join('\n');
    expect(all).toContain('plan-outing');
    expect(all).toContain('"op":"gen_ai.invoke_agent"');
    expect(all).toContain('"op":"cg.match"');
    expect(all).toContain('chat gemma3:4b');
    expect(all).toMatch(/"gen_ai\.usage\.input_tokens":(321|\{"value":321)/);
    expect(all).toContain('"server_name":"common-ground"');
    for (const secret of [...tokens, doc.id, (await import('node:os')).hostname(), 'Private Title', 'Nick0Private', 'East (test)', '16:41', 'A short green walk', 'Riverside']) {
      expect(all).not.toContain(secret);
    }
    expect(all).not.toMatch(/\b48613\b|maxTotalCost|originArea|nickname/);
  });
});
