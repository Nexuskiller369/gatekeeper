/**
 * THE AUTHORIZATION ENGINE
 *
 * `decide()` is a PURE function: it receives facts (who the actor is, their grants,
 * delegations, absences, the job and its history, and the time T) and returns an
 * explained ALLOW/DENY. It never touches the database. That gives us three things:
 *   1. one place where every permission rule lives (controllers never decide),
 *   2. easy unit tests (just build facts in memory),
 *   3. historical questions for free: load the facts as they were at T and call decide(T).
 *
 * It FAILS CLOSED: anything unexpected becomes DENY with code INDETERMINATE.
 */
import type { Direction, Mode, Stage, UserStatus, UserType } from '@prisma/client';
import {
  NEXT_ACTION,
  SOD_RULES,
  STAGE_RULES,
  WORK_ACTIONS,
  isPermission,
  type JobAction,
  type Permission,
} from '../domain/permissions';
import {
  type JobAttributes,
  type Scope,
  type ScopeField,
  describeMismatch,
  describeScope,
  fieldLabels,
  intersectScopes,
  mismatchedFields,
  scopeContains,
} from './scope';

// ---------------------------------------------------------------- facts (input)

export interface GrantFact {
  id: string;
  roleId: string;
  permissions: string[];
  isPrivileged: boolean;
  scope: Scope;
  validFrom: Date;
  validUntil: Date | null;
  revokedAt: Date | null;
}

export interface DelegationFact {
  id: string;
  delegatorId: string;
  delegatorName: string;
  delegatorStatus: UserStatus;
  roleId: string;
  scope: Scope;
  validFrom: Date;
  validUntil: Date;
  revokedAt: Date | null;
  /** The delegator's own grants: a delegate can never get more than the delegator has. */
  delegatorGrants: GrantFact[];
}

export interface PeriodFact {
  startsAt: Date;
  endsAt: Date;
  cancelledAt: Date | null;
}

export interface ActorFact {
  id: string;
  name: string;
  type: UserType;
  status: UserStatus;
  clientId: string | null;
  absences: PeriodFact[];
}

export interface JobFact extends JobAttributes {
  id: string | null; // null when evaluating a job that is about to be created
  reference: string;
  stage: Stage | null;
}

export interface HistoryFact {
  action: string;
  actorId: string;
}

export interface DecisionContext {
  actor: ActorFact | null;
  grants: GrantFact[];
  delegations: DelegationFact[];
}

// ---------------------------------------------------------------- decision (output)

export type DenyCode =
  | 'ACTOR_UNKNOWN'
  | 'ACTOR_INACTIVE'
  | 'UNKNOWN_ACTION'
  | 'JOB_NOT_FOUND'
  | 'FILED_LOCKED'
  | 'WRONG_STAGE'
  | 'ACTOR_ABSENT'
  | 'NO_PERMISSION'
  | 'SCOPE_MISMATCH'
  | 'CLIENT_BOUNDARY'
  | 'SOD_VIOLATION'
  | 'SELF_ESCALATION'
  | 'PRIVILEGED_ROLE'
  | 'TARGET_NOT_ALLOWED'
  | 'BEYOND_ADMIN_SCOPE'
  | 'INVALID_DELEGATION'
  | 'INDETERMINATE';

export interface TraceStep {
  check: string;
  result: 'PASS' | 'FAIL';
  detail: string;
}

export interface Decision {
  decision: 'ALLOW' | 'DENY';
  code: 'ALLOWED' | DenyCode;
  reason: string;
  action: string;
  actor: { id: string; name: string } | null;
  job: { id: string | null; reference: string } | null;
  via?: 'DIRECT' | 'DELEGATION';
  matchedGrantId?: string;
  matchedRole?: string;
  delegationId?: string;
  onBehalfOfId?: string;
  failedConditions?: string[];
  trace: TraceStep[];
  evaluatedAt: string;
}

/** Where a person's authority for a permission comes from, and how far it reaches. */
export interface AuthoritySource {
  via: 'DIRECT' | 'DELEGATION';
  grant: GrantFact;
  roleId: string;
  scope: Scope;
  delegation?: DelegationFact;
}

// ---------------------------------------------------------------- helpers

export function isActiveAt(
  item: { validFrom: Date; validUntil: Date | null; revokedAt: Date | null },
  at: Date,
): boolean {
  if (item.validFrom > at) return false;
  if (item.validUntil && item.validUntil <= at) return false;
  if (item.revokedAt && item.revokedAt <= at) return false;
  return true;
}

export function isAbsentAt(actor: ActorFact, at: Date): boolean {
  if (actor.type === 'SERVICE') return false;
  return actor.absences.some(
    (a) => a.startsAt <= at && at < a.endsAt && !(a.cancelledAt && a.cancelledAt <= at),
  );
}

/**
 * Every source of authority the actor has for `permission` at time `at`:
 *  - DIRECT: their own grants whose role includes the permission
 *  - DELEGATION: a delegation to them, where (a) they are themselves qualified for the role
 *    somewhere, (b) the delegator holds a matching grant, and (c) the reach is the
 *    INTERSECTION of the delegator's grant and the delegation's scope.
 * CLIENT users are additionally clamped to their own client, whatever their grant says.
 *
 * This single function feeds both decide() and the SQL list filters.
 */
export function authoritySources(ctx: DecisionContext, permission: Permission, at: Date): AuthoritySource[] {
  const actor = ctx.actor;
  if (!actor) return [];
  const sources: AuthoritySource[] = [];

  for (const g of ctx.grants) {
    if (isActiveAt(g, at) && g.permissions.includes(permission)) {
      sources.push({ via: 'DIRECT', grant: g, roleId: g.roleId, scope: g.scope });
    }
  }

  if (actor.type === 'STAFF') {
    for (const d of ctx.delegations) {
      if (!isActiveAt(d, at) || d.delegatorStatus !== 'ACTIVE') continue;
      const qualified = ctx.grants.some((g) => g.roleId === d.roleId && isActiveAt(g, at));
      if (!qualified) continue;
      for (const dg of d.delegatorGrants) {
        if (dg.roleId !== d.roleId || dg.isPrivileged) continue;
        if (!isActiveAt(dg, at) || !dg.permissions.includes(permission)) continue;
        const reach = intersectScopes(dg.scope, d.scope);
        if (reach) sources.push({ via: 'DELEGATION', grant: dg, roleId: d.roleId, scope: reach, delegation: d });
      }
    }
  }

  if (actor.type === 'CLIENT') {
    // Defence in depth: even a mis-configured grant cannot reach another client's jobs.
    const clamp: Scope = { clientId: actor.clientId ?? '__none__', branchId: null, direction: null, mode: null };
    return sources
      .map((s) => ({ ...s, scope: intersectScopes(s.scope, clamp) }))
      .filter((s): s is AuthoritySource => s.scope !== null);
  }
  return sources;
}

// ---------------------------------------------------------------- the decision

class DecisionBuilder {
  trace: TraceStep[] = [];
  constructor(
    private action: string,
    private ctx: DecisionContext,
    private job: JobFact | null,
    private at: Date,
  ) {}

  pass(check: string, detail: string) {
    this.trace.push({ check, result: 'PASS', detail });
  }

  base() {
    return {
      action: this.action,
      actor: this.ctx.actor ? { id: this.ctx.actor.id, name: this.ctx.actor.name } : null,
      job: this.job ? { id: this.job.id, reference: this.job.reference } : null,
      evaluatedAt: this.at.toISOString(),
    };
  }

  deny(check: string, code: DenyCode, reason: string, failedConditions?: string[]): Decision {
    this.trace.push({ check, result: 'FAIL', detail: reason });
    return { decision: 'DENY', code, reason, ...this.base(), failedConditions, trace: this.trace };
  }

  allow(reason: string, src: AuthoritySource): Decision {
    return {
      decision: 'ALLOW',
      code: 'ALLOWED',
      reason,
      ...this.base(),
      via: src.via,
      matchedGrantId: src.grant.id,
      matchedRole: src.roleId,
      delegationId: src.delegation?.id,
      onBehalfOfId: src.delegation?.delegatorId,
      trace: this.trace,
    };
  }
}

/**
 * May `ctx.actor` perform `action` on `job` at time `at`?
 * `history` is the job's history up to `at` (used for separation of duties).
 */
export function decide(
  ctx: DecisionContext,
  action: string,
  job: JobFact | null,
  history: HistoryFact[],
  at: Date = new Date(),
): Decision {
  const b = new DecisionBuilder(action, ctx, job, at);
  try {
    // 1. Identity
    const actor = ctx.actor;
    if (!actor) return b.deny('identity', 'ACTOR_UNKNOWN', 'Unknown user.');
    if (actor.status !== 'ACTIVE') {
      return b.deny('identity', 'ACTOR_INACTIVE', `${actor.name}'s account is inactive.`);
    }
    b.pass('identity', `${actor.name} is an active ${actor.type.toLowerCase()} user.`);

    // 2. Known action (fail closed on anything we do not recognise)
    if (!isPermission(action) || !action.startsWith('job.')) {
      return b.deny('action', 'UNKNOWN_ACTION', `'${action}' is not a known job action.`);
    }
    const jobAction = action as JobAction;

    // 3. Job exists
    if (!job) return b.deny('job', 'JOB_NOT_FOUND', 'Job not found.');

    // 4. Workflow stage (this is also where filed-job protection lives)
    const rule = STAGE_RULES[jobAction];
    if (rule.from !== 'ANY') {
      if (!job.stage || !rule.from.includes(job.stage)) {
        if (job.stage === 'FILED') {
          return b.deny(
            'stage',
            'FILED_LOCKED',
            `Job ${job.reference} is FILED and locked. Only an in-scope Operations Admin can cancel or reopen it, with a reason.`,
          );
        }
        return b.deny(
          'stage',
          'WRONG_STAGE',
          `'${action}' is only possible from ${rule.from.join(' or ')}; job ${job.reference} is ${job.stage}.`,
        );
      }
      b.pass('stage', `Job is ${job.stage}; '${action}' is allowed from that stage.`);
    }

    // 5. Absence
    if (WORK_ACTIONS.includes(jobAction) && isAbsentAt(actor, at)) {
      return b.deny('absence', 'ACTOR_ABSENT', `${actor.name} is marked absent at ${at.toISOString()}.`);
    }

    // 6. Client boundary (a client's employee only ever sees their own company's jobs)
    if (actor.type === 'CLIENT' && actor.clientId !== job.clientId) {
      return b.deny('client-boundary', 'CLIENT_BOUNDARY', 'Client users can only access their own company\'s jobs.', ['client']);
    }

    // 7. Does any role give this permission at all?
    const sources = authoritySources(ctx, jobAction, at);
    if (sources.length === 0) {
      const lapsed = ctx.grants.filter((g) => g.permissions.includes(jobAction) && !isActiveAt(g, at));
      const extra = lapsed.length
        ? ` (${lapsed.length} matching grant(s) exist but were not active at that time: expired, revoked or not yet started)`
        : '';
      return b.deny('permission', 'NO_PERMISSION', `${actor.name} has no active role that includes '${action}'${extra}.`);
    }
    b.pass('permission', `Roles with '${action}': ${[...new Set(sources.map((s) => s.roleId))].join(', ')}.`);

    // 8. Scope: client, branch, direction, mode
    const matching = sources.filter((s) => mismatchedFields(s.scope, job).length === 0);
    if (matching.length === 0) {
      let closest = sources[0];
      let closestMiss: ScopeField[] = mismatchedFields(closest.scope, job);
      for (const s of sources) {
        const miss = mismatchedFields(s.scope, job);
        if (miss.length < closestMiss.length) {
          closest = s;
          closestMiss = miss;
        }
      }
      return b.deny(
        'scope',
        'SCOPE_MISMATCH',
        `No ${closest.roleId} access covers this job. Closest: ${closest.roleId} for ${describeScope(closest.scope)}` +
          `${closest.via === 'DELEGATION' ? ' (via delegation)' : ''}; mismatch on ${describeMismatch(closestMiss, job)}.`,
        fieldLabels(closestMiss),
      );
    }
    // Prefer direct authority over delegated authority when both exist.
    const chosen = matching.find((s) => s.via === 'DIRECT') ?? matching[0];
    b.pass(
      'scope',
      `${chosen.roleId} for ${describeScope(chosen.scope)} covers this job` +
        (chosen.via === 'DELEGATION' ? ` (delegated by ${chosen.delegation!.delegatorName})` : '') + '.',
    );

    // 9. Separation of duties
    for (const sod of SOD_RULES.filter((r) => r.action === jobAction)) {
      const conflict = history.find((h) => h.actorId === actor.id && sod.conflictsWith.includes(h.action));
      if (conflict) return b.deny('separation-of-duties', 'SOD_VIOLATION', sod.message);
    }
    if (SOD_RULES.some((r) => r.action === jobAction)) {
      b.pass('separation-of-duties', 'No conflicting earlier action by this person on this job.');
    }

    const viaText =
      chosen.via === 'DELEGATION' ? `, delegated by ${chosen.delegation!.delegatorName} until ${chosen.delegation!.validUntil.toISOString()}` : '';
    return b.allow(
      `${actor.name} has ${chosen.roleId} access for ${describeScope(chosen.scope)}${viaText}, which covers this ${job.direction} ${job.mode} job for ${job.clientId} at ${job.branchId}.`,
      chosen,
    );
  } catch (err) {
    return b.deny('engine', 'INDETERMINATE', `Could not evaluate safely, so access is denied (${(err as Error).message}).`);
  }
}

/** Convenience: the next action a job at this stage is waiting for (or null if none). */
export function nextActionFor(stage: Stage): JobAction | null {
  return NEXT_ACTION[stage] ?? null;
}

// ---------------------------------------------------------------- access administration

export interface AccessChangeTarget {
  id: string;
  name: string;
  type: UserType;
  clientId: string | null;
}

export interface ProposedAccess {
  roleId: string;
  rolePermissions: string[];
  roleIsPrivileged: boolean;
  scope: Scope;
}

/**
 * May the admin in `ctx` grant / revoke `proposed` for `target`?
 * Rules: needs access.manage; never on yourself (self-escalation); never a privileged role
 * (those are bootstrap-only); only within the admin's own scope; client users only get
 * read-only access to their own client; service identities are not managed through the API.
 */
export function decideAccessChange(
  ctx: DecisionContext,
  operation: 'GRANT' | 'REVOKE' | 'DELEGATE',
  target: AccessChangeTarget,
  proposed: ProposedAccess,
  at: Date = new Date(),
): Decision {
  const job = null;
  const b = new DecisionBuilder(`access.${operation.toLowerCase()}`, ctx, job, at);
  try {
    const actor = ctx.actor;
    if (!actor) return b.deny('identity', 'ACTOR_UNKNOWN', 'Unknown user.');
    if (actor.status !== 'ACTIVE') return b.deny('identity', 'ACTOR_INACTIVE', `${actor.name}'s account is inactive.`);
    b.pass('identity', `${actor.name} is active.`);

    const adminSources = authoritySources(ctx, 'access.manage', at);
    if (adminSources.length === 0) {
      return b.deny('permission', 'NO_PERMISSION', `${actor.name} cannot manage access.`);
    }
    b.pass('permission', `${actor.name} holds access.manage.`);

    if (target.id === actor.id) {
      return b.deny('self-escalation', 'SELF_ESCALATION', 'Administrators cannot change their own access.');
    }
    if (proposed.roleIsPrivileged) {
      return b.deny(
        'privileged-role',
        'PRIVILEGED_ROLE',
        `${proposed.roleId} is a privileged role and can only be assigned through the audited bootstrap process.`,
      );
    }
    if (target.type === 'SERVICE') {
      return b.deny('target', 'TARGET_NOT_ALLOWED', 'Service identities are not managed through this API.');
    }
    if (target.type === 'CLIENT') {
      const readOnly = proposed.rolePermissions.every((p) => p === 'job.view');
      if (!readOnly || proposed.scope.clientId !== target.clientId) {
        return b.deny(
          'target',
          'TARGET_NOT_ALLOWED',
          `Client users may only receive read-only access scoped to their own client (${target.clientId}).`,
        );
      }
    }
    const container = adminSources.find((s) => scopeContains(s.scope, proposed.scope));
    if (!container) {
      return b.deny(
        'admin-scope',
        'BEYOND_ADMIN_SCOPE',
        `The requested scope (${describeScope(proposed.scope)}) is wider than ${actor.name}'s own administrative scope.`,
      );
    }
    b.pass('admin-scope', `Within admin scope ${describeScope(container.scope)}.`);
    return b.allow(`${actor.name} may ${operation.toLowerCase()} ${proposed.roleId} for ${target.name}.`, container);
  } catch (err) {
    return b.deny('engine', 'INDETERMINATE', `Could not evaluate safely, so access is denied (${(err as Error).message}).`);
  }
}
