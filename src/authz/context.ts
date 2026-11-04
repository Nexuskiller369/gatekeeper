/**
 * The "fact loader": reads everything the pure engine needs from the database.
 * We load ALL grants/delegations (including ended ones); the engine decides which
 * were active at time T. That is what makes historical questions possible.
 */
import type { Job, Prisma } from '@prisma/client';
import type { Db } from '../db';
import type { DecisionContext, GrantFact, HistoryFact, JobFact } from './engine';
import { toScope } from './scope';

type GrantRow = Prisma.AccessGrantGetPayload<{ include: { role: true } }>;

function toGrantFact(g: GrantRow): GrantFact {
  return {
    id: g.id,
    roleId: g.roleId,
    permissions: g.role.permissions,
    isPrivileged: g.role.isPrivileged,
    scope: toScope(g),
    validFrom: g.validFrom,
    validUntil: g.validUntil,
    revokedAt: g.revokedAt,
  };
}

const CONTEXT_INCLUDE = {
  absences: true,
  grants: { include: { role: true } },
  delegationsHeld: {
    include: { delegator: { include: { grants: { include: { role: true } } } } },
  },
} satisfies Prisma.UserInclude;

type UserWithFacts = Prisma.UserGetPayload<{ include: typeof CONTEXT_INCLUDE }>;

type AnyDb = Db | Prisma.TransactionClient;

export async function loadContext(db: AnyDb, userId: string): Promise<DecisionContext> {
  const user = await db.user.findUnique({ where: { id: userId }, include: CONTEXT_INCLUDE });
  if (!user) return { actor: null, grants: [], delegations: [] };
  return toContext(user);
}

/** Load many users' facts in ONE query (routing and "who could act" evaluate everyone). */
export async function loadContexts(db: AnyDb, where: Prisma.UserWhereInput): Promise<DecisionContext[]> {
  const users = await db.user.findMany({ where, include: CONTEXT_INCLUDE, orderBy: { id: 'asc' } });
  return users.map(toContext);
}

function toContext(user: UserWithFacts): DecisionContext {
  return {
    actor: {
      id: user.id,
      name: user.name,
      type: user.type,
      status: user.status,
      clientId: user.clientId,
      absences: user.absences.map((a) => ({ startsAt: a.startsAt, endsAt: a.endsAt, cancelledAt: a.cancelledAt })),
    },
    grants: user.grants.map(toGrantFact),
    delegations: user.delegationsHeld.map((d) => ({
      id: d.id,
      delegatorId: d.delegatorId,
      delegatorName: d.delegator.name,
      delegatorStatus: d.delegator.status,
      roleId: d.roleId,
      scope: toScope(d),
      validFrom: d.validFrom,
      validUntil: d.validUntil,
      revokedAt: d.revokedAt,
      delegatorGrants: d.delegator.grants.map(toGrantFact),
    })),
  };
}

export function toJobFact(job: Pick<Job, 'id' | 'reference' | 'clientId' | 'branchId' | 'direction' | 'mode' | 'stage'>): JobFact {
  return {
    id: job.id,
    reference: job.reference,
    clientId: job.clientId,
    branchId: job.branchId,
    direction: job.direction,
    mode: job.mode,
    stage: job.stage,
  };
}

/** History facts for separation-of-duties, optionally only what had happened by time `at`. */
export async function loadHistoryFacts(
  db: AnyDb,
  jobId: string,
  at?: Date,
): Promise<HistoryFact[]> {
  const rows = await db.jobHistory.findMany({
    where: { jobId, ...(at ? { createdAt: { lte: at } } : {}) },
    select: { action: true, actorId: true },
  });
  return rows;
}
