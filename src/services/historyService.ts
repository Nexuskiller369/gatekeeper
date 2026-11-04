/**
 * History and explanation:
 *  - a job's history (who did what, under which grant)
 *  - "why can she do this and he can't?"  -> explain()
 *  - "who could have changed this job at time T?" -> whoCouldAct()
 *
 * Three different questions, kept deliberately separate:
 *  1. Who ACTUALLY did it?           -> JobHistory rows
 *  2. Under what authority?          -> JobHistory.grantId / delegationId
 *  3. Who COULD have done it at T?   -> re-run the engine with the facts as they were at T
 */
import type { Job, Stage } from '@prisma/client';
import { authoritySources, decide, type Decision, type DecisionContext } from '../authz/engine';
import { loadContext, loadContexts, loadHistoryFacts, toJobFact } from '../authz/context';
import { prisma } from '../db';
import { STAGE_RULES, isPermission, type JobAction } from '../domain/permissions';
import { AppError, notFound } from '../http/errors';
import { findJob, getVisibleJob } from './jobService';

export async function getJobHistory(userId: string, idOrRef: string) {
  // Auditors / access admins (access.explain or audit.view) may read any job's trail,
  // consistent with whoCouldAct(); everyone else needs job.view on this job.
  const callerCtx = await loadContext(prisma, userId);
  let ctx: DecisionContext;
  let job: Job;
  if (canInvestigate(callerCtx)) {
    const found = await findJob(idOrRef);
    if (!found) throw notFound();
    ctx = callerCtx;
    job = found;
  } else {
    ({ ctx, job } = await getVisibleJob(userId, idOrRef));
  }
  const rows = await prisma.jobHistory.findMany({
    where: { jobId: job.id },
    orderBy: { createdAt: 'asc' },
    include: { actor: { select: { id: true, name: true, type: true } }, onBehalfOf: { select: { id: true, name: true } } },
  });
  // Client users see the status trail, not internal staff identities or grant details.
  const isClient = ctx.actor?.type === 'CLIENT';
  return {
    job: { id: job.id, reference: job.reference, stage: job.stage },
    history: rows.map((r) =>
      isClient
        ? { action: r.action, fromStage: r.fromStage, toStage: r.toStage, at: r.createdAt, actor: 'NFPL' }
        : {
            action: r.action,
            fromStage: r.fromStage,
            toStage: r.toStage,
            at: r.createdAt,
            actor: r.actor,
            via: r.via,
            onBehalfOf: r.onBehalfOf,
            reason: r.reason,
            grantId: r.grantId,
            delegationId: r.delegationId,
            changes: r.changes,
          },
    ),
  };
}

/** The job's stage at time T, rebuilt from history (attributes are immutable, so only stage varies). */
export async function stageAt(jobId: string, at: Date): Promise<Stage | null> {
  const last = await prisma.jobHistory.findFirst({
    where: { jobId, createdAt: { lte: at }, toStage: { not: null } },
    orderBy: { createdAt: 'desc' },
  });
  return last?.toStage ?? null; // null = the job did not exist yet
}

function canInvestigate(ctx: DecisionContext) {
  return authoritySources(ctx, 'access.explain', new Date()).length > 0 || authoritySources(ctx, 'audit.view', new Date()).length > 0;
}

async function jobFactAt(job: Job, at: Date | undefined) {
  if (!at) return { fact: toJobFact(job), history: await loadHistoryFacts(prisma, job.id) };
  const stage = await stageAt(job.id, at);
  return { fact: { ...toJobFact(job), stage }, history: await loadHistoryFacts(prisma, job.id, at) };
}

/**
 * Explain decisions for one or more users. You can always ask about yourself (for a job you
 * can see); asking about anyone else requires access.explain.
 */
export async function explain(callerId: string, input: { action: string; jobId: string; userIds?: string[]; at?: Date }) {
  const callerCtx = await loadContext(prisma, callerId);
  const userIds = input.userIds?.length ? input.userIds : [callerId];
  const aboutOthers = userIds.some((u) => u !== callerId);
  const investigator = authoritySources(callerCtx, 'access.explain', new Date()).length > 0;
  if (aboutOthers && !investigator) {
    throw new AppError(403, 'NO_PERMISSION', 'You can only ask about your own access. Explaining others requires access.explain.');
  }

  const job = await findJob(input.jobId);
  if (!job) throw notFound();
  if (!investigator) {
    // Self-explanation only for jobs you can see.
    const view = decide(callerCtx, 'job.view', toJobFact(job), await loadHistoryFacts(prisma, job.id));
    if (view.decision === 'DENY') throw notFound();
  }
  if (!isPermission(input.action)) throw new AppError(400, 'UNKNOWN_ACTION', `Unknown action '${input.action}'.`);

  const at = input.at ?? new Date();
  const { fact, history } = await jobFactAt(job, input.at);
  if (fact.stage === null) throw new AppError(400, 'JOB_DID_NOT_EXIST', `Job ${job.reference} did not exist at ${at.toISOString()}.`);

  const decisions: Decision[] = [];
  for (const id of userIds) {
    const ctx = await loadContext(prisma, id);
    if (!ctx.actor) throw new AppError(404, 'NOT_FOUND', `User ${id} not found.`);
    decisions.push(decide(ctx, input.action, fact, history, at));
  }
  return { job: { id: job.id, reference: job.reference, stageAtTime: fact.stage }, at: at.toISOString(), decisions };
}

/**
 * "Who could have changed this job at time T?" Every user is evaluated by the same engine
 * against the facts at T: grants active then, delegations active then, absences then,
 * and the job's stage then. Also lists what was ACTUALLY done that day.
 */
export async function whoCouldAct(callerId: string, idOrRef: string, at: Date, onlyAction?: string) {
  const callerCtx = await loadContext(prisma, callerId);
  if (!canInvestigate(callerCtx)) throw new AppError(403, 'NO_PERMISSION', 'Requires access.explain or audit.view.');
  const job = await findJob(idOrRef);
  if (!job) throw notFound();

  const { fact, history } = await jobFactAt(job, at);
  if (fact.stage === null) throw new AppError(400, 'JOB_DID_NOT_EXIST', `Job ${job.reference} did not exist at ${at.toISOString()}.`);

  const changeActions = (Object.keys(STAGE_RULES) as JobAction[]).filter((a) => {
    if (a === 'job.view' || a === 'job.create') return false;
    if (onlyAction && a !== onlyAction) return false;
    const from = STAGE_RULES[a].from;
    return from === 'ANY' || from.includes(fact.stage!);
  });

  const everyone = await loadContexts(prisma, {});
  const actions = changeActions.map((action) => ({
    action,
    couldAct: everyone
      .map((ctx) => ({ ctx, d: decide(ctx, action, fact, history, at) }))
      .filter(({ d }) => d.decision === 'ALLOW')
      .map(({ ctx, d }) => ({ userId: ctx.actor!.id, name: ctx.actor!.name, via: d.via, grantId: d.matchedGrantId, delegationId: d.delegationId, reason: d.reason })),
  }));

  const dayStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);
  const actuallyDone = await prisma.jobHistory.findMany({
    where: { jobId: job.id, createdAt: { gte: dayStart, lt: dayEnd } },
    orderBy: { createdAt: 'asc' },
    include: { actor: { select: { id: true, name: true } } },
  });

  return {
    job: { id: job.id, reference: job.reference },
    at: at.toISOString(),
    stageAtTime: fact.stage,
    couldAct: actions,
    actuallyDoneThatDay: actuallyDone.map((h) => ({ at: h.createdAt, actor: h.actor, action: h.action, fromStage: h.fromStage, toStage: h.toStage, grantId: h.grantId, reason: h.reason })),
    note: 'User account status (active/inactive) is evaluated as it is today; grants, delegations, absences and job stage are evaluated as they were at the requested time.',
  };
}
