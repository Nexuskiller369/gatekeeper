/**
 * AUTOMATION: routing and reassignment.
 * Automation never decides permissions itself. It asks the engine, for every candidate,
 * "could this person perform the job's next step?", and it acts under its own service
 * identity ('automation'), which itself needs job.assign.
 *
 * Simplification (documented): this runs synchronously right after the transition commits,
 * instead of through a transactional outbox + background worker.
 */
import type { Job } from '@prisma/client';
import { decide, nextActionFor } from '../authz/engine';
import { loadContext, loadContexts, loadHistoryFacts, toJobFact } from '../authz/context';
import { prisma } from '../db';

export const AUTOMATION_USER_ID = 'automation';
const OPEN_STAGES = ['CONFIRMED', 'PREPARED', 'CHECKED', 'REOPENED'] as const;

export interface RouteResult {
  jobId: string;
  assigneeId: string | null;
  eligible: string[];
  outcome: 'ASSIGNED' | 'NO_ELIGIBLE_USER' | 'NOTHING_TO_DO' | 'SKIPPED';
}

/**
 * Assign the job to an eligible person for its next step.
 * Strategy (deterministic, documented): fewest open assigned jobs, ties broken by user id.
 */
export async function routeJob(jobId: string, opts: { exclude?: string[]; rule?: string } = {}): Promise<RouteResult> {
  const rule = opts.rule ?? 'ROUTING';
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return { jobId, assigneeId: null, eligible: [], outcome: 'SKIPPED' };
  const next = nextActionFor(job.stage);
  if (!next) return { jobId, assigneeId: null, eligible: [], outcome: 'NOTHING_TO_DO' };

  const history = await loadHistoryFacts(prisma, job.id);
  const fact = toJobFact(job);

  // The automation identity must itself be allowed to assign this job.
  const automation = await loadContext(prisma, AUTOMATION_USER_ID);
  const own = decide(automation, 'job.assign', fact, history);
  if (own.decision === 'DENY') {
    await log(rule, job.id, 'FAILED', { reason: `Automation may not assign: ${own.reason}` });
    return { jobId, assigneeId: null, eligible: [], outcome: 'SKIPPED' };
  }

  // Ask the engine about every active staff member. 500 users is a small in-memory loop.
  const staff = await loadContexts(prisma, { type: 'STAFF', status: 'ACTIVE' });
  const eligible = staff
    .filter((c) => !(opts.exclude ?? []).includes(c.actor!.id))
    .filter((c) => decide(c, next, fact, history).decision === 'ALLOW')
    .map((c) => c.actor!.id);

  if (eligible.length === 0) {
    await writeAssignment(job, null, own.matchedGrantId ?? null, 'ROUTING_FAILED', { nextAction: next, reason: 'No eligible person' });
    await log(rule, job.id, 'FAILED', { nextAction: next, reason: 'No eligible person; job left unassigned for manual attention' });
    return { jobId, assigneeId: null, eligible, outcome: 'NO_ELIGIBLE_USER' };
  }

  const loads = await prisma.job.groupBy({
    by: ['assigneeId'],
    where: { assigneeId: { in: eligible }, stage: { in: [...OPEN_STAGES] } },
    _count: { _all: true },
  });
  const load = new Map(loads.map((l) => [l.assigneeId, l._count._all]));
  const chosen = [...eligible].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || a.localeCompare(b))[0];

  await writeAssignment(job, chosen, own.matchedGrantId ?? null, 'ASSIGN', { nextAction: next, eligibleCount: eligible.length });
  await log(rule, job.id, 'SUCCESS', { nextAction: next, assigneeId: chosen, eligible });
  return { jobId, assigneeId: chosen, eligible, outcome: 'ASSIGNED' };
}

async function writeAssignment(job: Job, assigneeId: string | null, grantId: string | null, action: string, details: object) {
  await prisma.$transaction(async (tx) => {
    const res = await tx.job.updateMany({ where: { id: job.id, version: job.version }, data: { assigneeId, version: { increment: 1 } } });
    if (res.count === 0) throw new Error('Job changed while routing; will be routed by the newer change.');
    await tx.jobHistory.create({
      data: {
        jobId: job.id,
        actorId: AUTOMATION_USER_ID,
        via: 'AUTOMATION',
        action,
        fromStage: job.stage,
        toStage: job.stage,
        grantId,
        changes: { assigneeId: { from: job.assigneeId, to: assigneeId }, ...details },
      },
    });
  });
}

async function log(rule: string, jobId: string, outcome: string, details: object) {
  await prisma.automationLog.create({ data: { rule, jobId, action: 'ROUTE', outcome, details: details as object } });
}

/**
 * Re-check every open job assigned to `userId`; any job they can no longer act on
 * (absent, deactivated, grant revoked) is re-routed to someone eligible, or left
 * unassigned with a FAILED log entry for manual attention. Permissions are never copied.
 */
export async function revalidateAssignments(userId: string, rule = 'ABSENCE_REASSIGN') {
  const jobs = await prisma.job.findMany({ where: { assigneeId: userId, stage: { in: [...OPEN_STAGES] } } });
  const ctx = await loadContext(prisma, userId);
  const results: RouteResult[] = [];
  for (const job of jobs) {
    const next = nextActionFor(job.stage);
    if (!next) continue;
    const history = await loadHistoryFacts(prisma, job.id);
    if (decide(ctx, next, toJobFact(job), history).decision === 'ALLOW') continue; // still fine
    results.push(await routeJob(job.id, { exclude: [userId], rule }));
  }
  return results;
}
