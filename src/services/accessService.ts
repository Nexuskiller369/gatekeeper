/**
 * Access administration: "manage who has what".
 * Every change - allowed OR denied - is written to AccessAuditLog.
 * Grants are never deleted; revoking sets revokedAt so history stays answerable.
 */
import type { Direction, Mode, Prisma, UserStatus } from '@prisma/client';
import { authoritySources, decideAccessChange, isActiveAt, type Decision } from '../authz/engine';
import { loadContext } from '../authz/context';
import { describeDelegation, describeGrant } from '../authz/describe';
import { toScope, type Scope } from '../authz/scope';
import { prisma } from '../db';
import { AppError, forbidden } from '../http/errors';
import { revalidateAssignments } from './routingService';

export interface ScopeInput {
  clientId?: string | null;
  branchId?: string | null;
  direction?: Direction | null;
  mode?: Mode | null;
}

async function audit(data: Prisma.AccessAuditLogUncheckedCreateInput) {
  await prisma.accessAuditLog.create({ data });
}

async function denyAndAudit(actorId: string, targetUserId: string | null, action: string, d: Decision, details: object): Promise<never> {
  await audit({ actorId, targetUserId, action, outcome: 'DENIED', code: d.code, reason: d.reason, details: details as Prisma.InputJsonValue });
  throw forbidden(d);
}

/** A DENY decision for admin rules checked outside decideAccessChange (same shape, so callers see one format). */
function adminDenial(actorId: string, action: string, code: Decision['code'], reason: string, actorName = actorId): Decision {
  return {
    decision: 'DENY', code, reason, action,
    actor: { id: actorId, name: actorName }, job: null,
    trace: [{ check: code === 'SELF_ESCALATION' ? 'self-escalation' : 'delegation', result: 'FAIL', detail: reason }],
    evaluatedAt: new Date().toISOString(),
  };
}

async function validateScope(scope: Scope) {
  if (scope.clientId && !(await prisma.client.findUnique({ where: { id: scope.clientId } }))) {
    throw new AppError(400, 'UNKNOWN_CLIENT', `Unknown client ${scope.clientId}.`);
  }
  if (scope.branchId && !(await prisma.branch.findUnique({ where: { id: scope.branchId } }))) {
    throw new AppError(400, 'UNKNOWN_BRANCH', `Unknown branch ${scope.branchId}.`);
  }
}

async function requireUser(id: string) {
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) throw new AppError(404, 'NOT_FOUND', `User ${id} not found.`);
  return u;
}

async function requireRole(id: string) {
  const r = await prisma.role.findUnique({ where: { id } });
  if (!r) throw new AppError(400, 'UNKNOWN_ROLE', `Unknown role ${id}.`);
  return r;
}

async function requireManager(actorId: string) {
  const ctx = await loadContext(prisma, actorId);
  if (authoritySources(ctx, 'access.manage', new Date()).length === 0) {
    throw new AppError(403, 'NO_PERMISSION', 'Requires access.manage.');
  }
  return ctx;
}

// ---------------------------------------------------------------- grants

export async function createGrant(
  actorId: string,
  input: ScopeInput & { userId: string; roleId: string; validFrom?: Date; validUntil?: Date | null; reason: string },
) {
  const ctx = await loadContext(prisma, actorId);
  const target = await requireUser(input.userId);
  const role = await requireRole(input.roleId);
  const scope = toScope(input);
  await validateScope(scope);
  if (input.validUntil && input.validFrom && input.validUntil <= input.validFrom) {
    throw new AppError(400, 'INVALID_PERIOD', 'validUntil must be after validFrom.');
  }

  const d = decideAccessChange(ctx, 'GRANT', target, { roleId: role.id, rolePermissions: role.permissions, roleIsPrivileged: role.isPrivileged, scope });
  if (d.decision === 'DENY') await denyAndAudit(actorId, target.id, 'GRANT', d, { roleId: role.id, scope });

  const grant = await prisma.$transaction(async (tx) => {
    const g = await tx.accessGrant.create({
      data: { userId: target.id, roleId: role.id, ...scope, validFrom: input.validFrom ?? new Date(), validUntil: input.validUntil ?? null, reason: input.reason, grantedById: actorId },
    });
    await tx.accessAuditLog.create({
      data: { actorId, targetUserId: target.id, action: 'GRANT', outcome: 'ALLOWED', reason: input.reason, details: { grantId: g.id, roleId: role.id, scope } as Prisma.InputJsonValue },
    });
    return g;
  });
  return { grant, description: describeGrant(target.name, grant) };
}

export async function revokeGrant(actorId: string, grantId: string, reason: string) {
  const ctx = await loadContext(prisma, actorId);
  const grant = await prisma.accessGrant.findUnique({ where: { id: grantId }, include: { role: true, user: true } });
  if (!grant) throw new AppError(404, 'NOT_FOUND', 'Grant not found.');
  if (grant.revokedAt) throw new AppError(409, 'ALREADY_REVOKED', 'This grant is already revoked.');

  const d = decideAccessChange(ctx, 'REVOKE', grant.user, {
    roleId: grant.roleId,
    rolePermissions: grant.role.permissions,
    roleIsPrivileged: grant.role.isPrivileged,
    scope: toScope(grant),
  });
  if (d.decision === 'DENY') await denyAndAudit(actorId, grant.userId, 'REVOKE', d, { grantId });

  const revoked = await prisma.$transaction(async (tx) => {
    const g = await tx.accessGrant.update({ where: { id: grantId }, data: { revokedAt: new Date(), revokedById: actorId, revokeReason: reason } });
    await tx.accessAuditLog.create({ data: { actorId, targetUserId: grant.userId, action: 'REVOKE', outcome: 'ALLOWED', reason, details: { grantId } } });
    return g;
  });
  // Q5: jobs assigned to this person that they can no longer do are re-routed now.
  const reassigned = await revalidateAssignments(grant.userId, 'ACCESS_CHANGE_REASSIGN');
  return { grant: revoked, description: describeGrant(grant.user.name, revoked), reassigned };
}

export async function listGrants(actorId: string, userId?: string) {
  const ctx = await loadContext(prisma, actorId);
  const isAdmin =
    authoritySources(ctx, 'access.manage', new Date()).length > 0 || authoritySources(ctx, 'audit.view', new Date()).length > 0;
  if (!isAdmin && userId !== actorId) throw new AppError(403, 'NO_PERMISSION', 'You can only list your own grants.');
  const grants = await prisma.accessGrant.findMany({
    where: userId ? { userId } : {},
    include: { user: { select: { name: true } } },
    orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }],
  });
  const now = new Date();
  return grants.map((g) => ({ ...g, active: isActiveAt(g, now), description: describeGrant(g.user.name, g, now) }));
}

// ---------------------------------------------------------------- delegations

export async function createDelegation(
  actorId: string,
  input: ScopeInput & { delegatorId: string; delegateId: string; roleId: string; validFrom?: Date; validUntil: Date; reason: string },
) {
  const ctx = await loadContext(prisma, actorId);
  const delegator = await requireUser(input.delegatorId);
  const delegate = await requireUser(input.delegateId);
  const role = await requireRole(input.roleId);
  const scope = toScope(input);
  await validateScope(scope);
  const validFrom = input.validFrom ?? new Date();
  const details = { delegatorId: delegator.id, delegateId: delegate.id, roleId: role.id, scope };

  if (actorId === delegator.id || actorId === delegate.id) {
    await denyAndAudit(actorId, delegate.id, 'DELEGATE', adminDenial(actorId, 'access.delegate', 'SELF_ESCALATION', 'Administrators cannot create delegations they are part of.'), details);
  }
  const d = decideAccessChange(ctx, 'DELEGATE', delegate, { roleId: role.id, rolePermissions: role.permissions, roleIsPrivileged: role.isPrivileged, scope });
  if (d.decision === 'DENY') await denyAndAudit(actorId, delegate.id, 'DELEGATE', d, details);

  const invalid = (reason: string) =>
    denyAndAudit(actorId, delegate.id, 'DELEGATE', adminDenial(actorId, 'access.delegate', 'INVALID_DELEGATION', reason), details);
  if (delegator.id === delegate.id) await invalid('Delegator and delegate must be different people.');
  if (input.validUntil <= validFrom) await invalid('validUntil must be after validFrom.');
  if (input.validUntil.getTime() - validFrom.getTime() > 30 * 24 * 3600_000) await invalid('Delegations are limited to 30 days.');

  const now = new Date();
  const [delegatorGrants, delegateGrants] = await Promise.all([
    prisma.accessGrant.findMany({ where: { userId: delegator.id, roleId: role.id } }),
    prisma.accessGrant.findMany({ where: { userId: delegate.id, roleId: role.id } }),
  ]);
  if (!delegatorGrants.some((g) => isActiveAt(g, now))) await invalid(`${delegator.name} does not hold ${role.id}, so has nothing to delegate.`);
  if (!delegateGrants.some((g) => isActiveAt(g, now))) {
    await invalid(`${delegate.name} is not qualified as ${role.id}. Delegation lends scope, not qualification.`);
  }

  const delegation = await prisma.$transaction(async (tx) => {
    const created = await tx.delegation.create({
      data: { delegatorId: delegator.id, delegateId: delegate.id, roleId: role.id, ...scope, validFrom, validUntil: input.validUntil, reason: input.reason, createdById: actorId },
    });
    await tx.accessAuditLog.create({
      data: { actorId, targetUserId: delegate.id, action: 'DELEGATE', outcome: 'ALLOWED', reason: input.reason, details: { delegationId: created.id, ...details } as Prisma.InputJsonValue },
    });
    return created;
  });
  return { delegation, description: describeDelegation(delegate.name, delegator.name, delegation) };
}

export async function revokeDelegation(actorId: string, id: string, reason: string) {
  await requireManager(actorId);
  const del = await prisma.delegation.findUnique({ where: { id } });
  if (!del) throw new AppError(404, 'NOT_FOUND', 'Delegation not found.');
  if (del.revokedAt) throw new AppError(409, 'ALREADY_REVOKED', 'Delegation already revoked.');
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.delegation.update({ where: { id }, data: { revokedAt: new Date() } });
    await tx.accessAuditLog.create({ data: { actorId, targetUserId: del.delegateId, action: 'DELEGATION_REVOKE', outcome: 'ALLOWED', reason, details: { delegationId: id } } });
    return u;
  });
  const reassigned = await revalidateAssignments(del.delegateId, 'ACCESS_CHANGE_REASSIGN');
  return { delegation: updated, reassigned };
}

export async function listDelegations(actorId: string) {
  await requireManager(actorId);
  const rows = await prisma.delegation.findMany({ include: { delegator: true, delegate: true }, orderBy: { createdAt: 'desc' } });
  return rows.map(({ delegator, delegate, ...d }) => ({ ...d, description: describeDelegation(delegate.name, delegator.name, d as never) }));
}

// ---------------------------------------------------------------- absence & status

export async function recordAbsence(actorId: string, userId: string, input: { startsAt: Date; endsAt: Date; reason: string }) {
  await requireManager(actorId);
  const user = await requireUser(userId);
  if (user.type === 'SERVICE') throw new AppError(400, 'TARGET_NOT_ALLOWED', 'Service identities do not take leave.');
  if (input.endsAt <= input.startsAt) throw new AppError(400, 'INVALID_PERIOD', 'endsAt must be after startsAt.');

  const absence = await prisma.$transaction(async (tx) => {
    const a = await tx.absence.create({ data: { userId, ...input, createdById: actorId } });
    await tx.accessAuditLog.create({
      data: { actorId, targetUserId: userId, action: 'ABSENCE', outcome: 'ALLOWED', reason: input.reason, details: { absenceId: a.id, startsAt: input.startsAt.toISOString(), endsAt: input.endsAt.toISOString() } },
    });
    return a;
  });
  // If the absence has already started, move their assigned work to eligible colleagues now.
  const now = new Date();
  const reassigned = input.startsAt <= now && now < input.endsAt ? await revalidateAssignments(userId, 'ABSENCE_REASSIGN') : [];
  return { absence, reassigned };
}

export async function setUserStatus(actorId: string, userId: string, status: UserStatus, reason: string) {
  const ctx = await requireManager(actorId);
  const user = await requireUser(userId);
  if (userId === actorId) {
    await denyAndAudit(actorId, userId, 'STATUS', adminDenial(actorId, 'access.status', 'SELF_ESCALATION', 'Administrators cannot change their own account status.', ctx.actor!.name), { status });
  }
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({ where: { id: userId }, data: { status } });
    await tx.accessAuditLog.create({ data: { actorId, targetUserId: userId, action: 'STATUS', outcome: 'ALLOWED', reason, details: { from: user.status, to: status } } });
    return u;
  });
  const reassigned = status === 'INACTIVE' ? await revalidateAssignments(userId, 'ACCESS_CHANGE_REASSIGN') : [];
  return { user: { id: updated.id, name: updated.name, status: updated.status }, reassigned };
}

// ---------------------------------------------------------------- reading

export async function describeUserAccess(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      grants: { orderBy: { createdAt: 'asc' } },
      delegationsHeld: { include: { delegator: true } },
      absences: { where: { cancelledAt: null }, orderBy: { startsAt: 'desc' } },
    },
  });
  if (!user) throw new AppError(404, 'NOT_FOUND', `User ${userId} not found.`);
  const now = new Date();
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    type: user.type,
    clientId: user.clientId,
    status: user.status,
    absentNow: user.absences.some((a) => a.startsAt <= now && now < a.endsAt),
    access: user.grants.map((g) => describeGrant(user.name, g, now)),
    delegations: user.delegationsHeld.map((d) => describeDelegation(user.name, d.delegator.name, d)),
    absences: user.absences.map((a) => ({ startsAt: a.startsAt, endsAt: a.endsAt, reason: a.reason })),
  };
}

export async function listUsers(actorId: string) {
  const ctx = await loadContext(prisma, actorId);
  const ok = authoritySources(ctx, 'access.manage', new Date()).length > 0 || authoritySources(ctx, 'audit.view', new Date()).length > 0;
  if (!ok) throw new AppError(403, 'NO_PERMISSION', 'Requires access.manage or audit.view.');
  const users = await prisma.user.findMany({ orderBy: { id: 'asc' }, select: { id: true } });
  return Promise.all(users.map((u) => describeUserAccess(u.id)));
}

export async function readAccessAudit(actorId: string, q: { userId?: string; limit: number }) {
  const ctx = await loadContext(prisma, actorId);
  if (authoritySources(ctx, 'audit.view', new Date()).length === 0) throw new AppError(403, 'NO_PERMISSION', 'Requires audit.view.');
  return prisma.accessAuditLog.findMany({
    where: q.userId ? { OR: [{ actorId: q.userId }, { targetUserId: q.userId }] } : {},
    orderBy: { createdAt: 'desc' },
    take: q.limit,
  });
}

export async function readAutomationLog(actorId: string, q: { jobId?: string; limit: number }) {
  const ctx = await loadContext(prisma, actorId);
  if (authoritySources(ctx, 'audit.view', new Date()).length === 0 && authoritySources(ctx, 'job.assign', new Date()).length === 0) {
    throw new AppError(403, 'NO_PERMISSION', 'Requires audit.view or job.assign.');
  }
  return prisma.automationLog.findMany({ where: q.jobId ? { jobId: q.jobId } : {}, orderBy: { createdAt: 'desc' }, take: q.limit });
}
