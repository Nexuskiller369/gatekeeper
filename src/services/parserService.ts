/**
 * OVERNIGHT PARSER (simulated system integration).
 *
 * Runs as the SYSTEM_PARSER service identity and goes through the same services - and so the
 * same AuthorizationEngine - as a human. It has no special path into the database.
 *
 * Per record:
 *   invalid shape              -> INVALID   (nothing written to jobs)
 *   new externalRef            -> CREATED   (engine: job.create)
 *   known externalRef, changes -> UPDATED   (engine: job.import_update, only before preparation)
 *   known externalRef, same    -> UNCHANGED (re-running the same file is a no-op: idempotent)
 *   engine/business refusal    -> REJECTED  (e.g. the job was already prepared)
 * One bad record never stops the batch. Every outcome is written to AutomationLog (rule PARSER).
 */
import { z } from 'zod';
import { loadContext, loadHistoryFacts, toJobFact } from '../authz/context';
import { decide } from '../authz/engine';
import { prisma } from '../db';
import { AppError } from '../http/errors';
import { createJob, performJobAction } from './jobService';

export const PARSER_USER_ID = 'parser';

/** What one shipment record from the feed must look like. */
export const shipmentRecord = z.object({
  externalRef: z.string().trim().min(3).max(60),
  reference: z.string().trim().min(3).max(40).optional(), // NFPL job reference; derived if absent
  clientId: z.string().trim().min(1),
  branchId: z.string().trim().min(1),
  direction: z.enum(['IMPORT', 'EXPORT']),
  mode: z.enum(['AIR', 'FCL', 'LCL']),
  consignee: z.string().trim().min(1).max(200),
  weightKg: z.coerce.number().positive(),
  valueInr: z.coerce.number().nonnegative(),
});
export type ShipmentRecord = z.infer<typeof shipmentRecord>;

export type ParserOutcome = 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'REJECTED' | 'INVALID';

export interface RecordResult {
  index: number;
  externalRef: string | null;
  outcome: ParserOutcome;
  jobReference?: string;
  code?: string;
  message?: string;
}

export interface ParserRun {
  runId: string;
  results: RecordResult[];
  summary: Record<ParserOutcome, number>;
}

/** Fields the parser owns and may update. Routing/stage/assignee are never touched by it. */
const IMPORTED_FIELDS = ['consignee', 'weightKg', 'valueInr'] as const;

export async function runParser(records: unknown[], runId = `run_${new Date().toISOString()}`): Promise<ParserRun> {
  const results: RecordResult[] = [];
  for (let i = 0; i < records.length; i++) {
    const result = await processRecord(i, records[i]);
    results.push(result);
    await prisma.automationLog.create({
      data: {
        rule: 'PARSER',
        action: result.outcome,
        outcome: result.outcome === 'INVALID' || result.outcome === 'REJECTED' ? 'FAILED' : result.outcome === 'UNCHANGED' ? 'SKIPPED' : 'SUCCESS',
        jobId: result.jobReference ? (await prisma.job.findUnique({ where: { reference: result.jobReference }, select: { id: true } }))?.id ?? null : null,
        details: { runId, ...result } as object,
      },
    });
  }
  const summary = { CREATED: 0, UPDATED: 0, UNCHANGED: 0, REJECTED: 0, INVALID: 0 } as Record<ParserOutcome, number>;
  for (const r of results) summary[r.outcome]++;
  return { runId, results, summary };
}

async function processRecord(index: number, raw: unknown): Promise<RecordResult> {
  const parsed = shipmentRecord.safeParse(raw);
  const externalRef = typeof (raw as { externalRef?: unknown })?.externalRef === 'string' ? (raw as { externalRef: string }).externalRef : null;
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.') || 'record'}: ${i.message}`).join('; ');
    return { index, externalRef, outcome: 'INVALID', code: 'VALIDATION_ERROR', message };
  }
  const rec = parsed.data;

  try {
    const existing = await prisma.job.findUnique({ where: { externalRef: rec.externalRef } });
    if (!existing) {
      const reference = rec.reference ?? `NF-${rec.externalRef.replace(/[^A-Za-z0-9-]/g, '').toUpperCase()}`;
      const { job } = await createJob(PARSER_USER_ID, {
        reference,
        externalRef: rec.externalRef,
        clientId: rec.clientId,
        branchId: rec.branchId,
        direction: rec.direction,
        mode: rec.mode,
        consignee: rec.consignee,
        weightKg: rec.weightKg,
        valueInr: rec.valueInr,
      });
      return { index, externalRef: rec.externalRef, outcome: 'CREATED', jobReference: job.reference };
    }

    // The routing attributes (client/branch/direction/mode) decide who may see and act on a job.
    // The feed is not allowed to move a job between scopes; that would silently change access.
    const moved = (['clientId', 'branchId', 'direction', 'mode'] as const).filter((k) => existing[k] !== rec[k]);
    if (moved.length) {
      return {
        index, externalRef: rec.externalRef, outcome: 'REJECTED', jobReference: existing.reference, code: 'SCOPE_FIELDS_CHANGED',
        message: `The feed tried to change ${moved.join(', ')}; these decide access and need a human.`,
      };
    }

    const changes = Object.fromEntries(IMPORTED_FIELDS.map((k) => [k, rec[k]]));
    const res = await performJobAction(PARSER_USER_ID, existing.reference, 'job.import_update', { changes });
    return { index, externalRef: rec.externalRef, outcome: 'unchanged' in res && res.unchanged ? 'UNCHANGED' : 'UPDATED', jobReference: existing.reference };
  } catch (err) {
    if (err instanceof AppError) {
      // The parser cannot see jobs (no job.view), so a refused update surfaces as NOT_FOUND;
      // ask the engine directly for the real reason so the log is useful.
      const why = err.code === 'NOT_FOUND' ? await explainParserDenial(rec.externalRef) : null;
      return { index, externalRef: rec.externalRef, outcome: 'REJECTED', jobReference: why?.reference, code: why?.code ?? err.code, message: why?.reason ?? err.message };
    }
    throw err; // genuinely unexpected (DB down etc.): stop, do not pretend the batch worked
  }
}

async function explainParserDenial(externalRef: string) {
  const job = await prisma.job.findUnique({ where: { externalRef } });
  if (!job) return null;
  const ctx = await loadContext(prisma, PARSER_USER_ID);
  const d = decide(ctx, 'job.import_update', toJobFact(job), await loadHistoryFacts(prisma, job.id));
  return d.decision === 'DENY' ? { reference: job.reference, code: d.code, reason: d.reason } : null;
}
