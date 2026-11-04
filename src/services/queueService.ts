/**
 * "Jobs waiting for me". Not a separately maintained task list: it is a database query built
 * from the SAME authoritySources() + STAGE_RULES + SOD_RULES the engine uses. A test checks
 * that every job in this list is one the engine would ALLOW, and that none are missing.
 *
 * A job is waiting for me when:
 *   (its stage needs action A) AND (one of my scopes for A covers it)
 *   AND (separation of duties does not rule me out) AND (it is assigned to me OR unassigned)
 */
import type { Prisma, Stage } from '@prisma/client';
import { authoritySources, isAbsentAt } from '../authz/engine';
import { loadContext } from '../authz/context';
import { scopeToJobWhere } from '../authz/scope';
import { prisma } from '../db';
import { NEXT_ACTION, SOD_RULES, type JobAction } from '../domain/permissions';

export async function waitingForMeWhere(userId: string, at = new Date()): Promise<Prisma.JobWhereInput | null> {
  const ctx = await loadContext(prisma, userId);
  if (!ctx.actor || ctx.actor.status !== 'ACTIVE' || isAbsentAt(ctx.actor, at)) return null;

  // Group stages by the action they wait for: prepare <- CONFIRMED/REOPENED, check <- PREPARED, file <- CHECKED
  const stagesByAction = new Map<JobAction, Stage[]>();
  for (const [stage, action] of Object.entries(NEXT_ACTION) as [Stage, JobAction][]) {
    stagesByAction.set(action, [...(stagesByAction.get(action) ?? []), stage]);
  }

  const branches: Prisma.JobWhereInput[] = [];
  for (const [action, stages] of stagesByAction) {
    const sources = authoritySources(ctx, action, at);
    if (sources.length === 0) continue;
    const conflicts = SOD_RULES.filter((r) => r.action === action).flatMap((r) => r.conflictsWith);
    branches.push({
      AND: [
        { stage: { in: stages } },
        { OR: sources.map((s) => scopeToJobWhere(s.scope)) },
        ...(conflicts.length ? [{ history: { none: { actorId: userId, action: { in: conflicts } } } }] : []),
      ],
    });
  }
  if (branches.length === 0) return null;
  return { AND: [{ OR: branches }, { OR: [{ assigneeId: userId }, { assigneeId: null }] }] };
}

export async function waitingForMe(userId: string, q: { cursor?: string; limit: number }) {
  const where = await waitingForMeWhere(userId);
  if (!where) return { total: 0, items: [], nextCursor: null };
  // Count and page come from the SAME where clause, so the badge number matches the list.
  const [total, items] = await Promise.all([
    prisma.job.count({ where }),
    prisma.job.findMany({
      where: { AND: [where, ...(q.cursor ? [{ id: { gt: q.cursor } }] : [])] },
      orderBy: { id: 'asc' },
      take: q.limit,
    }),
  ]);
  return {
    total,
    items: items.map((j) => ({ ...j, nextAction: NEXT_ACTION[j.stage], assignedToMe: j.assigneeId === userId })),
    nextCursor: items.length === q.limit ? items[items.length - 1].id : null,
  };
}
