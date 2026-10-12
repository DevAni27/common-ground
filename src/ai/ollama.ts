/**
 * Minimal Ollama client for structured outputs. Server-side only: the browser
 * never sees the Ollama endpoint. One generation at a time (laptop GPU with
 * 6 GB VRAM), temperature 0, bounded output, hard timeout.
 */
import { z } from 'zod';
import { span } from '../telemetry.ts';

export interface OllamaConfig { baseUrl: string; model: string; timeoutMs?: number; numCtx?: number; numPredict?: number }

export interface GenerationMetrics {
  model: string;
  elapsedMs: number;
  /** As reported by Ollama; null if not reported. */
  promptTokens: number | null;
  outputTokens: number | null;
  totalDurationMs: number | null;
}

export type GenerationResult<T> =
  | { ok: true; value: T; metrics: GenerationMetrics }
  | { ok: false; error: 'UNAVAILABLE' | 'TIMEOUT' | 'HTTP_ERROR' | 'INVALID_JSON' | 'SCHEMA_MISMATCH'; detail: string; metrics: GenerationMetrics | null };

let queue: Promise<unknown> = Promise.resolve();
/** Serialises local generations so two requests never compete for the GPU. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.catch(() => undefined).then(fn);
  queue = run.catch(() => undefined);
  return run;
}

export async function ollamaAvailable(cfg: OllamaConfig, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; models: string[]; detail?: string }> {
  try {
    const res = await fetchImpl(`${cfg.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, models: [], detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { models?: Array<{ name: string }> };
    const models = (body.models ?? []).map((m) => m.name);
    return { ok: models.includes(cfg.model), models, detail: models.includes(cfg.model) ? undefined : `Model ${cfg.model} not pulled` };
  } catch (e) {
    return { ok: false, models: [], detail: (e as Error).message };
  }
}

export async function generateStructured<S extends z.ZodTypeAny>(
  cfg: OllamaConfig, schema: S, system: string, user: string, fetchImpl: typeof fetch = fetch,
): Promise<GenerationResult<z.infer<S>>> {
  return exclusive(() => span(`chat ${cfg.model}`, 'gen_ai.chat', async (sp) => {
    sp.set({ 'gen_ai.system': 'ollama', 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': cfg.model });
    const r = await generateOnce(cfg, schema, system, user, fetchImpl);
    if (r.metrics) sp.set({ 'gen_ai.usage.input_tokens': r.metrics.promptTokens ?? undefined, 'gen_ai.usage.output_tokens': r.metrics.outputTokens ?? undefined });
    sp.set({ 'gen_ai.response.valid': r.ok });
    if (!r.ok) sp.fail(r.error);
    return r;
  }));
}

async function generateOnce<S extends z.ZodTypeAny>(
  cfg: OllamaConfig, schema: S, system: string, user: string, fetchImpl: typeof fetch,
): Promise<GenerationResult<z.infer<S>>> {
  {
    const started = performance.now();
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 60_000),
        body: JSON.stringify({
          model: cfg.model,
          stream: false,
          format: z.toJSONSchema(schema),
          options: { temperature: 0, num_ctx: cfg.numCtx ?? 4096, num_predict: cfg.numPredict ?? 512 },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
    } catch (e) {
      const err = e as Error;
      const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      return { ok: false, error: timeout ? 'TIMEOUT' : 'UNAVAILABLE', detail: err.message, metrics: null };
    }
    const elapsedMs = Math.round(performance.now() - started);
    if (!res.ok) return { ok: false, error: 'HTTP_ERROR', detail: `HTTP ${res.status}`, metrics: null };
    const body = (await res.json().catch(() => null)) as null | { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; total_duration?: number };
    const metrics: GenerationMetrics = {
      model: cfg.model,
      elapsedMs,
      promptTokens: body?.prompt_eval_count ?? null,
      outputTokens: body?.eval_count ?? null,
      totalDurationMs: body?.total_duration ? Math.round(body.total_duration / 1e6) : null,
    };
    let parsedJson: unknown;
    try { parsedJson = JSON.parse(body?.message?.content ?? ''); } catch { return { ok: false, error: 'INVALID_JSON', detail: 'Model output was not JSON', metrics }; }
    const parsed = schema.safeParse(parsedJson);
    if (!parsed.success) return { ok: false, error: 'SCHEMA_MISMATCH', detail: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), metrics };
    return { ok: true, value: parsed.data, metrics };
  }
}
