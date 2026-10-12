/**
 * Mastra orchestration of the planning pipeline:
 *   snapshot-inputs → match (deterministic) → explain (local Gemma, grounded, with template fallback)
 * Application state (participants, plans, approvals) lives in the outing store,
 * not in Mastra. Mastra runs here use Mastra's default in-memory storage, so a
 * run in progress does not survive a server restart; a restart simply means
 * the organiser presses "Find plans" again. Confirmation/approval state is
 * persisted by the application store, not by a suspended workflow.
 */
// Mastra sends feature telemetry by default; keep this local app quiet unless explicitly re-enabled.
process.env.MASTRA_TELEMETRY_DISABLED ??= 'true';

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Mastra } from '@mastra/core';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { match, type CandidateEvaluation, type ParticipantInput } from '../domain/matching.ts';
import { toPublicCandidate } from '../domain/projection.ts';
import type { Dataset, SharedSettings } from '../domain/schemas.ts';
import { summarisePlans, toSummaryInput } from '../ai/summary.ts';
import type { OllamaConfig } from '../ai/ollama.ts';
import { span } from '../telemetry.ts';

export interface PlanningDeps {
  now: () => number;
  ollama: () => OllamaConfig | null;
  runLogFile: string | null;
}

export interface PlanningInput { settings: SharedSettings; participants: ParticipantInput[]; dataset: Dataset }

export interface PlanningOutput {
  runId: string;
  evaluated: number;
  counts: Record<'pass' | 'fail' | 'unknown', number>;
  fitting: CandidateEvaluation[];
  needsVerification: CandidateEvaluation[];
  summarySource: 'gemma' | 'template' | 'none';
  summaryFailure: string | null;
  steps: Array<{ id: string; status: string; ms: number | null }>;
}

const Any = z.any();

export function createPlanningEngine(deps: PlanningDeps) {
  // Inputs and match results contain private requirements; they stay in-process (in-memory Mastra storage).
  const snapshotInputs = createStep({
    id: 'snapshot-inputs',
    inputSchema: Any, outputSchema: Any,
    execute: async ({ inputData }) => {
      const input = inputData as PlanningInput;
      if (input.participants.length < 2) throw new Error('NOT_ENOUGH_PARTICIPANTS');
      return { ...input, now: deps.now() };
    },
  });

  const matchStep = createStep({
    id: 'match',
    inputSchema: Any, outputSchema: Any,
    execute: async ({ inputData }) => {
      const { settings, participants, dataset, now } = inputData as PlanningInput & { now: number };
      const r = await span('match', 'cg.match', async (sp) => {
        const m = match(settings, participants, dataset, { timeZone: settings.timeZone, now });
        sp.set({ 'cg.evaluated': m.evaluated, 'cg.fitting': m.counts.pass, 'cg.needs_verification': m.counts.unknown });
        return m;
      });
      return { settings, participants, dataset, now, evaluated: r.evaluated, counts: r.counts, fitting: r.fitting, needsVerification: r.needsVerification };
    },
  });

  const explainStep = createStep({
    id: 'explain',
    inputSchema: Any, outputSchema: Any,
    execute: async ({ inputData }) => {
      const d = inputData as PlanningInput & { now: number; evaluated: number; counts: PlanningOutput['counts']; fitting: CandidateEvaluation[]; needsVerification: CandidateEvaluation[] };
      let summarySource: PlanningOutput['summarySource'] = 'none';
      let summaryFailure: string | null = null;
      if (d.fitting.length > 0) {
        // Only the PUBLIC projection reaches the model.
        const inputs = d.fitting.map((c) => toSummaryInput(toPublicCandidate(c, d.settings, d.participants, d.dataset, d.now, d.settings.timeZone)));
        const cfg = deps.ollama();
        const s = await span('explain', 'cg.explain', async (sp) => {
          const out = await summarisePlans(cfg ? { ...cfg, timeoutMs: 45_000 } : null, inputs, d.dataset.venues.map((v) => v.name));
          sp.set({ 'cg.options': inputs.length, 'cg.summary_source': out.source, 'cg.validation': out.failureReason ? 'rejected' : 'ok' });
          if (out.failureReason) sp.fail(out.failureReason);
          return out;
        });
        summarySource = s.source;
        summaryFailure = s.failureReason ?? null;
      }
      return { evaluated: d.evaluated, counts: d.counts, fitting: d.fitting, needsVerification: d.needsVerification, summarySource, summaryFailure };
    },
  });

  const workflow = createWorkflow({ id: 'plan-outing', inputSchema: Any, outputSchema: Any })
    .then(snapshotInputs).then(matchStep).then(explainStep).commit();
  const mastra = new Mastra({ workflows: { planOuting: workflow }, logger: false });

  async function logRun(entry: Record<string, unknown>) {
    if (!deps.runLogFile) return;
    try {
      await mkdir(path.dirname(deps.runLogFile), { recursive: true });
      await appendFile(deps.runLogFile, `${JSON.stringify(entry)}\n`);
    } catch { /* run log is best-effort */ }
  }

  return {
    async run(input: PlanningInput): Promise<PlanningOutput> {
      const run = await mastra.getWorkflow('planOuting').createRun();
      const started = Date.now();
      const res = await span('plan-outing', 'gen_ai.invoke_agent', async (sp) => {
        const r = await run.start({ inputData: input });
        sp.set({ 'cg.status': r.status });
        if (r.status !== 'success') sp.fail(r.status);
        return r;
      });
      const steps = Object.entries(res.steps ?? {})
        .filter(([id]) => id !== 'input')
        .map(([id, s]) => {
          const st = s as { status: string; startedAt?: number; endedAt?: number };
          return { id, status: st.status, ms: st.startedAt && st.endedAt ? st.endedAt - st.startedAt : null };
        });
      // Run evidence without private content: random run id, step names, statuses, timings, counts.
      await logRun({
        workflow: 'plan-outing', runId: run.runId, at: new Date(started).toISOString(), status: res.status, totalMs: Date.now() - started, steps,
        evaluated: res.status === 'success' ? (res.result as PlanningOutput).evaluated : null,
        summarySource: res.status === 'success' ? (res.result as PlanningOutput).summarySource : null,
      });
      if (res.status !== 'success') throw new Error(`Planning workflow ${res.status}`);
      return { ...(res.result as Omit<PlanningOutput, 'runId' | 'steps'>), runId: run.runId, steps };
    },
  };
}

export type PlanningEngine = ReturnType<typeof createPlanningEngine>;
