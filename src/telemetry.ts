/**
 * Optional Sentry tracing. Off unless SENTRY_DSN is set. Manual spans only:
 * default integrations (HTTP, console, request data, breadcrumbs) are disabled
 * so URLs, headers, cookies, bodies and prompts are never captured. Spans carry
 * step names, statuses, durations, counts and model token counts — never
 * prompts, responses, requirements, locations, names or capability links.
 */
type SentryModule = typeof import('@sentry/node');
let sentry: SentryModule | null = null;

const TOKENISH = /[A-Za-z0-9_-]{32,}/g;
const ALLOWED_ATTR = /^(gen_ai\.(system|operation\.name|request\.model|usage\.input_tokens|usage\.output_tokens|response\.valid)|cg\.(step|status|evaluated|fitting|needs_verification|options|summary_source|failure|validation))$/;

/** Removes everything except allow-listed attribute keys; scrubs long token-like strings. */
export function scrubAttributes(attrs: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!ALLOWED_ATTR.test(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.replace(TOKENISH, '[redacted]').slice(0, 80);
  }
  return out;
}

export async function initTelemetry(dsn: string | null, environment = 'local'): Promise<boolean> {
  if (!dsn) return false;
  sentry = await import('@sentry/node');
  sentry.init({
    dsn,
    environment,
    // The SDK would otherwise send the computer's hostname.
    serverName: 'common-ground',
    sendDefaultPii: false,
    defaultIntegrations: false,
    integrations: [],
    tracesSampleRate: 1.0,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    beforeSend(event) {
      delete event.request; delete event.user; delete event.breadcrumbs; delete event.extra; delete event.contexts?.trace?.data;
      if (event.message) event.message = event.message.replace(TOKENISH, '[redacted]');
      for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = ex.value.replace(TOKENISH, '[redacted]');
      return event;
    },
    beforeSendTransaction(event) {
      delete event.request; delete event.user; delete event.breadcrumbs; delete event.extra;
      for (const s of event.spans ?? []) s.data = scrubAttributes(s.data ?? {}) as typeof s.data;
      if (event.contexts?.trace?.data) event.contexts.trace.data = scrubAttributes(event.contexts.trace.data) as typeof event.contexts.trace.data;
      return event;
    },
  });
  return true;
}

export const telemetryEnabled = () => sentry !== null;

export interface SpanHandle { set(attrs: Record<string, unknown>): void; fail(code: string): void }

/** Runs `fn` inside a span when Sentry is enabled; a no-op wrapper otherwise. Telemetry failure never affects results. */
export async function span<T>(name: string, op: string, fn: (s: SpanHandle) => Promise<T>): Promise<T> {
  const noop: SpanHandle = { set() {}, fail() {} };
  if (!sentry) return fn(noop);
  return sentry.startSpan({ name, op, forceTransaction: false }, async (sp) => {
    const handle: SpanHandle = {
      set(attrs) { try { sp.setAttributes(scrubAttributes(attrs)); } catch { /* ignore */ } },
      fail(code) { try { sp.setStatus({ code: 2, message: code.replace(TOKENISH, '[redacted]').slice(0, 60) }); } catch { /* ignore */ } },
    };
    return fn(handle);
  });
}

/** Captures an unexpected server error by type and message only. */
export function captureError(err: unknown, where: string) {
  if (!sentry) return;
  try {
    const e = err instanceof Error ? err : new Error('non-error thrown');
    const safe = new Error(`${where}: ${e.message}`.replace(TOKENISH, '[redacted]').slice(0, 200));
    safe.name = e.name;
    safe.stack = e.stack;
    sentry.captureException(safe);
  } catch { /* ignore */ }
}

export async function flushTelemetry() { if (sentry) await sentry.flush(3000); }
