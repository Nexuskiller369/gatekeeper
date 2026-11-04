/**
 * Jobs: visibility, retrieval, creation, data edits and workflow transitions.
 * Every operation asks the AuthorizationEngine first; no permission logic lives here.
 */
import type { Direction, Job, Mode, Prisma, Stage } from '@prisma/client';
import { authoritySources, decide, nextActionFor, type Decision, type DecisionContext } from '../authz/engine';
import { loadContext, loadHistoryFacts, toJobFact } from '../authz/context';
import { scopeToJobWhere } from '../authz/scope';
import { prisma } from '../db';
import { HISTORY_ACTION, PERMISSIONS, STAGE_RULES, type JobAction } from '../domain/permissions';
import { AppError, forbidden, notFound } from '../http/errors';
import { routeJob } from './routingService';

export const EDITABLE_FIELDS = ['consignee', 'weightKg', 'valueInr', 'notes'] as const;
export type JobDataChanges = Partial<{ consignee: string; weightKg: number; valueInr: number; notes: string | null }>;

export async function findJob(idOrRef: string): Promise<Job | null> {
  return prisma.job.findFirst({ where: { OR: [{ id: idOrRef }, { reference: idOrRef }] } });
}

/**
 * VISIBILITY as a database filter: the union of the scopes of every grant that gives job.view.
 * Built from the same authoritySources() the engine uses, so lists and single checks agree.
 */
export function visibilityWhere(ctx: DecisionContext, at = new Date()): Prisma.JobWhereInput {
  if (!ctx.actor || ctx.actor.status !== 'ACTIVE') return { id: { in: [] } };
  const sources = authoritySources(ctx, 'job.view', at);
  if (sources.length === 0) return { id: { in: [] } };
  return { OR: sources.map((s) => scopeToJobWhere(s.scope)) };
}

export interface JobListQuery {
  stage?: Stage;
  clientId?: string;
  branchId?: string;
  direction?: Direction;
  mode?: Mode;
  assigneeId?: string;
  cursor?: string;
  limit: number;
}

/** Keyset pagination (WHERE id > cursor) stays fast on deep pages, unlike OFFSET. */
export async function listJobs(userId: string, q: JobListQuery) {
  const ctx = await loadContext(prisma, userId);
  const filters: Prisma.JobWhereInput = {
    ...(q.stage && { stage: q.stage }),
    ...(q.clientId && { clientId: q.clientId }),
    ...(q.branchId && { branchId: q.branchId }),
    ...(q.direction && { direction: q.direction }),
    ...(q.mode && { mode: q.mode }),
    ...(q.assigneeId && { assigneeId: q.assigneeId }),
  };
  const where: Prisma.JobWhereInput = { AND: [visibilityWhere(ctx), filters] };
  const [items, total] = await Promise.all([
    prisma.job.findMany({
      where: { AND: [where, ...(q.cursor ? [{ id: { gt: q.cursor } }] : [])] },
      orderBy: { id: 'asc' },
      take: q.limit,
    }),
    prisma.job.count({ where }),
  ]);
  return { total, items, nextCursor: items.length === q.limit ? items[items.length - 1].id : null };
}

/** Load a job the caller may SEE, or 404 (we never reveal that an invisible job exists). */
export async function getVisibleJob(userId: string, idOrRef: string) {
  const ctx = await loadContext(prisma, userId);
  const job = await findJob(idOrRef);
  if (!job) throw notFound();
  const history = await loadHistoryFacts(prisma, job.id);
  const view = decide(ctx, 'job.view', toJobFact(job), history);
  if (view.decision === 'DENY') throw notFound();
  return { ctx, job, history };
}

/** A job plus the list of actions the caller could perform on it right now. */
export async function getJobForUser(userId: string, idOrRef: string) {
  const { ctx, job, history } = await getVisibleJob(userId, idOrRef);
  const allowedActions = PERMISSIONS.filter((p) => p.startsWith('job.') && p !== 'job.view' && p !== 'job.create').filter(
    (p) => decide(ctx, p, toJobFact(job), history).decision === 'ALLOW',
  );
  return { ...job, allowedActions };
}

export interface CreateJobInput {
  reference: string;
  externalRef?: string | null;
  clientId: string;
  branchId: string;
  direction: Direction;
  mode: Mode;
  consignee: string;
  weightKg: number;
  valueInr: number;
  notes?: string | null;
}

export async function createJob(userId: string, input: CreateJobInput, opts: { route?: boolean } = {}) {
  const ctx = await loadContext(prisma, userId);
  const proposed = { id: null, reference: input.reference, clientId: input.clientId, branchId: input.branchId, direction: input.direction, mode: input.mode, stage: null };
  const d = decide(ctx, 'job.create', proposed, []);
  if (d.decision === 'DENY') throw forbidden(d);

  const [client, branch, existing] = await Promise.all([
    prisma.client.findUnique({ where: { id: input.clientId } }),
    prisma.branch.findUnique({ where: { id: input.branchId } }),
    prisma.job.findUnique({ where: { reference: input.reference } }),
  ]);
  if (!client) throw new AppError(400, 'UNKNOWN_CLIENT', `Unknown client ${input.clientId}.`);
  if (!branch) throw new AppError(400, 'UNKNOWN_BRANCH', `Unknown branch ${input.branchId}.`);
  if (existing) throw new AppError(409, 'DUPLICATE_REFERENCE', `Job ${input.reference} already exists.`);

  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.job.create({ data: { ...input, createdById: userId } });
    await tx.jobHistory.create({
      data: { jobId: created.id, actorId: userId, via: 'DIRECT', action: 'CREATE', toStage: 'CONFIRMED', grantId: d.matchedGrantId, changes: { ...input } as Prisma.InputJsonValue },
    });
    return created;
  });
  if (opts.route !== false) await safeRoute(job.id);
  return { job, decision: d };
}

export interface ActionOptions {
  reason?: string;
  changes?: JobDataChanges;
  assigneeId?: string | null;
}

/**
 * The one path every job change goes through:
 *   1. ask the engine (deny -> 403 with explanation, or 404 if you cannot even see the job)
 *   2. in ONE transaction: conditional update (optimistic concurrency) + history row
 *   3. after commit: route the job to whoever is needed next
 */
export async function performJobAction(userId: string, idOrRef: string, action: JobAction, opts: ActionOptions = {}) {
  const ctx = await loadContext(prisma, userId);
  const job = await findJob(idOrRef);
  if (!job) throw notFound();
  const history = await loadHistoryFacts(prisma, job.id);
  const fact = toJobFact(job);

  const d = decide(ctx, action, fact, history);
  if (d.decision === 'DENY') {
    if (decide(ctx, 'job.view', fact, history).decision === 'DENY') throw notFound();
    throw forbidden(d);
  }

  const rule = STAGE_RULES[action];
  const data: Prisma.JobUpdateManyMutationInput & { assigneeId?: string | null } = { version: { increment: 1 } };
  let changes: Record<string, { from: unknown; to: unknown }> | undefined;

  if (rule.to) {
    data.stage = rule.to;
    data.stageEnteredAt = new Date();
    data.assigneeId = null; // the next person is chosen by routing
  }
  if (action === 'job.edit' || action === 'job.import_update') {
    changes = diff(job, opts.changes ?? {});
    if (Object.keys(changes).length === 0) return { job, decision: d, unchanged: true };
    for (const [k, v] of Object.entries(changes)) (data as Record<string, unknown>)[k] = v.to;
  }
  if (action === 'job.assign') {
    await assertAssignable(job, opts.assigneeId ?? null, history);
    data.assigneeId = opts.assigneeId ?? null;
    changes = { assigneeId: { from: job.assigneeId, to: opts.assigneeId ?? null } };
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Optimistic concurrency: only succeeds if nobody changed the job since we read it.
    const res = await tx.job.updateMany({ where: { id: job.id, version: job.version }, data });
    if (res.count === 0) {
      throw new AppError(409, 'CONFLICT', 'This job was changed by someone else in the meantime. Reload and try again.');
    }
    await tx.jobHistory.create({
      data: {
        jobId: job.id,
        actorId: userId,
        onBehalfOfId: d.onBehalfOfId ?? null,
        via: d.via ?? 'DIRECT',
        action: HISTORY_ACTION[action],
        fromStage: job.stage,
        toStage: rule.to ?? job.stage,
        reason: opts.reason ?? null,
        grantId: d.matchedGrantId ?? null,
        delegationId: d.delegationId ?? null,
        changes: changes as Prisma.InputJsonValue | undefined,
      },
    });
    return tx.job.findUniqueOrThrow({ where: { id: job.id } });
  });

  if (rule.to) await safeRoute(updated.id);
  const after = await prisma.job.findUniqueOrThrow({ where: { id: updated.id } });
  return { job: after, decision: d };
}

function diff(job: Job, changes: JobDataChanges) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of EDITABLE_FIELDS) {
    if (!(f in changes)) continue;
    const before = job[f] === null ? null : f === 'weightKg' || f === 'valueInr' ? Number(job[f]) : job[f];
    const after = changes[f];
    if (before !== after) out[f] = { from: before, to: after };
  }
  return out;
}

/** An admin may only (re)assign a job to someone who could actually do its next step. */
async function assertAssignable(job: Job, assigneeId: string | null, history: Awaited<ReturnType<typeof loadHistoryFacts>>) {
  if (assigneeId === null) return;
  const next = nextActionFor(job.stage);
  if (!next) throw new AppError(400, 'NOT_ASSIGNABLE', `A ${job.stage} job is not waiting for anyone.`);
  const target = await loadContext(prisma, assigneeId);
  const d: Decision = decide(target, next, toJobFact(job), history);
  if (d.decision === 'DENY') {
    throw new AppError(400, 'ASSIGNEE_NOT_ELIGIBLE', `Cannot assign: ${d.reason}`, { decision: d });
  }
}

/** Routing is a follow-up step; a routing failure must never undo a committed transition. */
async function safeRoute(jobId: string) {
  try {
    await routeJob(jobId);
  } catch (err) {
    await prisma.automationLog.create({
      data: { rule: 'ROUTING', jobId, action: 'ROUTE', outcome: 'FAILED', details: { error: (err as Error).message } },
    });
  }
}
