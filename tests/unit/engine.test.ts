/**
 * Unit tests for the pure AuthorizationEngine. No database: we build the facts by hand,
 * which makes each rule easy to see in isolation.
 */
import { describe, expect, it } from 'vitest';
import {
  decide,
  decideAccessChange,
  type ActorFact,
  type DecisionContext,
  type DelegationFact,
  type GrantFact,
  type JobFact,
} from '../../src/authz/engine';
import { ANY_SCOPE, type Scope } from '../../src/authz/scope';

const NOW = new Date('2026-11-03T10:00:00Z');
const PAST = new Date('2026-01-01T00:00:00Z');
const FUTURE = new Date('2027-01-01T00:00:00Z');

const ROLE_PERMS: Record<string, string[]> = {
  MAKER: ['job.view', 'job.edit', 'job.prepare', 'job.cancel'],
  CHECKER: ['job.view', 'job.check', 'job.reject'],
  FILER: ['job.view', 'job.file'],
  OPS_ADMIN: ['job.view', 'job.cancel_filed', 'job.reopen', 'job.assign'],
  ACCESS_ADMIN: ['access.manage', 'access.explain', 'audit.view'],
  CLIENT_VIEWER: ['job.view'],
  SYSTEM_PARSER: ['job.create', 'job.import_update'],
};

let seq = 0;
function grant(roleId: string, scope: Partial<Scope> = {}, extra: Partial<GrantFact> = {}): GrantFact {
  return {
    id: `g${++seq}`,
    roleId,
    permissions: ROLE_PERMS[roleId],
    isPrivileged: ['OPS_ADMIN', 'ACCESS_ADMIN', 'SYSTEM_PARSER'].includes(roleId),
    scope: { ...ANY_SCOPE, ...scope },
    validFrom: PAST,
    validUntil: null,
    revokedAt: null,
    ...extra,
  };
}

function actor(id: string, extra: Partial<ActorFact> = {}): ActorFact {
  return { id, name: id, type: 'STAFF', status: 'ACTIVE', clientId: null, absences: [], ...extra };
}

function ctx(a: ActorFact | null, grants: GrantFact[], delegations: DelegationFact[] = []): DecisionContext {
  return { actor: a, grants, delegations };
}

const job = (extra: Partial<JobFact> = {}): JobFact => ({
  id: 'job1',
  reference: 'NF-0001',
  clientId: 'ACME',
  branchId: 'BOM',
  direction: 'IMPORT',
  mode: 'AIR',
  stage: 'PREPARED',
  ...extra,
});

// Raj: Checker for ACME, Mumbai, imports only.
const rajGrants = [grant('CHECKER', { clientId: 'ACME', branchId: 'BOM', direction: 'IMPORT' })];
const raj = ctx(actor('raj'), rajGrants);

describe('scope matching', () => {
  it('allows a checker whose client/branch/direction all match', () => {
    const d = decide(raj, 'job.check', job(), [], NOW);
    expect(d.decision).toBe('ALLOW');
    expect(d.matchedRole).toBe('CHECKER');
    expect(d.via).toBe('DIRECT');
  });

  it('denies on wrong client and names the failed condition', () => {
    const d = decide(raj, 'job.check', job({ clientId: 'BLUESKY' }), [], NOW);
    expect(d.code).toBe('SCOPE_MISMATCH');
    expect(d.failedConditions).toEqual(['client']);
  });

  it('denies on wrong branch', () => {
    const d = decide(raj, 'job.check', job({ branchId: 'DEL' }), [], NOW);
    expect(d.failedConditions).toEqual(['branch']);
  });

  it('denies on wrong direction', () => {
    const d = decide(raj, 'job.check', job({ direction: 'EXPORT' }), [], NOW);
    expect(d.failedConditions).toEqual(['direction']);
    expect(d.reason).toContain('direction (job is EXPORT)');
  });

  it('a maker-everywhere who is checker for only some clients: can prepare anywhere, check only in scope', () => {
    const sarah = ctx(actor('sarah'), [grant('MAKER'), grant('CHECKER', { clientId: 'ACME' })]);
    expect(decide(sarah, 'job.prepare', job({ stage: 'CONFIRMED', clientId: 'GLOBEX' }), [], NOW).decision).toBe('ALLOW');
    expect(decide(sarah, 'job.check', job({ clientId: 'ACME' }), [], NOW).decision).toBe('ALLOW');
    expect(decide(sarah, 'job.check', job({ clientId: 'GLOBEX' }), [], NOW).code).toBe('SCOPE_MISMATCH');
  });

  it('denies an action no role provides', () => {
    expect(decide(raj, 'job.file', job({ stage: 'CHECKED' }), [], NOW).code).toBe('NO_PERMISSION');
  });
});

describe('workflow stage and filed-job protection', () => {
  it('denies checking a job that is not PREPARED', () => {
    expect(decide(raj, 'job.check', job({ stage: 'CONFIRMED' }), [], NOW).code).toBe('WRONG_STAGE');
  });

  it('nobody can edit a FILED job, not even a maker everywhere', () => {
    const alice = ctx(actor('alice'), [grant('MAKER')]);
    const d = decide(alice, 'job.edit', job({ stage: 'FILED' }), [], NOW);
    expect(d.code).toBe('FILED_LOCKED');
  });

  it('a maker cannot cancel a FILED job (needs job.cancel_filed)', () => {
    const alice = ctx(actor('alice'), [grant('MAKER')]);
    expect(decide(alice, 'job.cancel_filed', job({ stage: 'FILED' }), [], NOW).code).toBe('NO_PERMISSION');
  });

  it('an in-scope ops admin can reopen a FILED job', () => {
    const ops = ctx(actor('omar'), [grant('OPS_ADMIN')]);
    expect(decide(ops, 'job.reopen', job({ stage: 'FILED' }), [], NOW).decision).toBe('ALLOW');
  });

  it('an ops admin scoped to another branch cannot', () => {
    const ops = ctx(actor('olivia'), [grant('OPS_ADMIN', { branchId: 'DEL' })]);
    expect(decide(ops, 'job.reopen', job({ stage: 'FILED' }), [], NOW).code).toBe('SCOPE_MISMATCH');
  });
});

describe('separation of duties', () => {
  const sarah = ctx(actor('sarah'), [grant('MAKER'), grant('CHECKER')]);

  it('the preparer cannot check their own job', () => {
    const d = decide(sarah, 'job.check', job(), [{ action: 'PREPARE', actorId: 'sarah' }], NOW);
    expect(d.code).toBe('SOD_VIOLATION');
  });

  it('a different qualified checker can', () => {
    const d = decide(sarah, 'job.check', job(), [{ action: 'PREPARE', actorId: 'alice' }], NOW);
    expect(d.decision).toBe('ALLOW');
  });

  it('applies to any earlier preparation cycle, even after a reopen', () => {
    const history = [
      { action: 'PREPARE', actorId: 'sarah' },
      { action: 'REOPEN', actorId: 'omar' },
      { action: 'PREPARE', actorId: 'alice' },
    ];
    expect(decide(sarah, 'job.check', job(), history, NOW).code).toBe('SOD_VIOLATION');
  });

  it('an ops admin who filed the job cannot cancel it', () => {
    const ops = ctx(actor('omar'), [grant('OPS_ADMIN'), grant('FILER')]);
    const d = decide(ops, 'job.cancel_filed', job({ stage: 'FILED' }), [{ action: 'FILE', actorId: 'omar' }], NOW);
    expect(d.code).toBe('SOD_VIOLATION');
  });
});

describe('absence, inactivity, time', () => {
  it('an absent user cannot do work', () => {
    const a = actor('priya', { absences: [{ startsAt: PAST, endsAt: FUTURE, cancelledAt: null }] });
    expect(decide(ctx(a, rajGrants), 'job.check', job(), [], NOW).code).toBe('ACTOR_ABSENT');
  });

  it('a cancelled absence does not block', () => {
    const a = actor('priya', { absences: [{ startsAt: PAST, endsAt: FUTURE, cancelledAt: PAST }] });
    expect(decide(ctx(a, rajGrants), 'job.check', job(), [], NOW).decision).toBe('ALLOW');
  });

  it('an inactive user is denied', () => {
    expect(decide(ctx(actor('eric', { status: 'INACTIVE' }), rajGrants), 'job.check', job(), [], NOW).code).toBe('ACTOR_INACTIVE');
  });

  it('a revoked grant is not used after revocation but was valid before it', () => {
    const revokedAt = new Date('2026-06-01T00:00:00Z');
    const c = ctx(actor('lena'), [grant('CHECKER', {}, { revokedAt })]);
    expect(decide(c, 'job.check', job(), [], NOW).code).toBe('NO_PERMISSION');
    expect(decide(c, 'job.check', job(), [], new Date('2026-05-01T00:00:00Z')).decision).toBe('ALLOW');
  });

  it('fails closed on an unknown action', () => {
    expect(decide(raj, 'job.delete_everything', job(), [], NOW).code).toBe('UNKNOWN_ACTION');
  });
});

describe('client users', () => {
  it('can view own client jobs but never another client, whatever the grant says', () => {
    const tom = actor('tom', { type: 'CLIENT', clientId: 'ACME' });
    const c = ctx(tom, [grant('CLIENT_VIEWER', { clientId: 'ACME' })]);
    expect(decide(c, 'job.view', job(), [], NOW).decision).toBe('ALLOW');
    const misconfigured = ctx(tom, [grant('CLIENT_VIEWER')]); // ANY client by mistake
    expect(decide(misconfigured, 'job.view', job({ clientId: 'BLUESKY' }), [], NOW).code).toBe('CLIENT_BOUNDARY');
  });

  it('cannot perform workflow actions', () => {
    const c = ctx(actor('tom', { type: 'CLIENT', clientId: 'ACME' }), [grant('CLIENT_VIEWER', { clientId: 'ACME' })]);
    expect(decide(c, 'job.check', job(), [], NOW).code).toBe('NO_PERMISSION');
  });
});

describe('parser (service identity)', () => {
  const parser = ctx(actor('parser', { type: 'SERVICE' }), [grant('SYSTEM_PARSER')]);
  it('can create and update imported data on a CONFIRMED job', () => {
    expect(decide(parser, 'job.create', job({ id: null, stage: null }), [], NOW).decision).toBe('ALLOW');
    expect(decide(parser, 'job.import_update', job({ stage: 'CONFIRMED' }), [], NOW).decision).toBe('ALLOW');
  });
  it('cannot check, file, or touch a filed job', () => {
    expect(decide(parser, 'job.check', job(), [], NOW).code).toBe('NO_PERMISSION');
    expect(decide(parser, 'job.file', job({ stage: 'CHECKED' }), [], NOW).code).toBe('NO_PERMISSION');
    expect(decide(parser, 'job.import_update', job({ stage: 'FILED' }), [], NOW).code).toBe('FILED_LOCKED');
  });
});

describe('delegation', () => {
  // Priya checks CORAL; she is away and delegates CORAL checking to Dev, who is a checker for EVEREST.
  const priyaCoral = grant('CHECKER', { clientId: 'CORAL' });
  const delegation = (extra: Partial<DelegationFact> = {}): DelegationFact => ({
    id: 'd1',
    delegatorId: 'priya',
    delegatorName: 'Priya',
    delegatorStatus: 'ACTIVE',
    roleId: 'CHECKER',
    scope: { ...ANY_SCOPE, clientId: 'CORAL' },
    validFrom: PAST,
    validUntil: FUTURE,
    revokedAt: null,
    delegatorGrants: [priyaCoral],
    ...extra,
  });
  const devGrants = [grant('CHECKER', { clientId: 'EVEREST' })];

  it('a qualified delegate can act within the delegated scope, and both people are identified', () => {
    const d = decide(ctx(actor('dev'), devGrants, [delegation()]), 'job.check', job({ clientId: 'CORAL' }), [], NOW);
    expect(d.decision).toBe('ALLOW');
    expect(d.via).toBe('DELEGATION');
    expect(d.onBehalfOfId).toBe('priya');
  });

  it('an expired delegation is denied', () => {
    const expired = delegation({ validUntil: new Date('2026-02-01T00:00:00Z') });
    const d = decide(ctx(actor('dev'), devGrants, [expired]), 'job.check', job({ clientId: 'CORAL' }), [], NOW);
    expect(d.code).toBe('SCOPE_MISMATCH');
  });

  it('delegation lends scope, not qualification: an unqualified delegate gets nothing', () => {
    const d = decide(ctx(actor('alice'), [grant('MAKER')], [delegation()]), 'job.check', job({ clientId: 'CORAL' }), [], NOW);
    expect(d.code).toBe('NO_PERMISSION');
  });

  it('the delegate never gets more than the delegator has', () => {
    const wide = delegation({ scope: ANY_SCOPE }); // delegation says ANY, but Priya only has CORAL
    const d = decide(ctx(actor('dev'), devGrants, [wide]), 'job.check', job({ clientId: 'DELTA' }), [], NOW);
    expect(d.code).toBe('SCOPE_MISMATCH');
  });
});

describe('access administration', () => {
  const admin = ctx(actor('anita'), [grant('ACCESS_ADMIN')]);
  const checker = { roleId: 'CHECKER', rolePermissions: ROLE_PERMS.CHECKER, roleIsPrivileged: false, scope: ANY_SCOPE };
  const staff = { id: 'raj', name: 'Raj', type: 'STAFF' as const, clientId: null };

  it('an admin can grant a normal role to someone else', () => {
    expect(decideAccessChange(admin, 'GRANT', staff, checker, NOW).decision).toBe('ALLOW');
  });

  it('an admin cannot grant themselves anything', () => {
    const self = { id: 'anita', name: 'Anita', type: 'STAFF' as const, clientId: null };
    expect(decideAccessChange(admin, 'GRANT', self, checker, NOW).code).toBe('SELF_ESCALATION');
  });

  it('privileged roles cannot be granted through the API', () => {
    const ops = { roleId: 'OPS_ADMIN', rolePermissions: ROLE_PERMS.OPS_ADMIN, roleIsPrivileged: true, scope: ANY_SCOPE };
    expect(decideAccessChange(admin, 'GRANT', staff, ops, NOW).code).toBe('PRIVILEGED_ROLE');
  });

  it('a branch-scoped admin cannot grant beyond their branch', () => {
    const branchAdmin = ctx(actor('bob'), [grant('ACCESS_ADMIN', { branchId: 'DEL' })]);
    expect(decideAccessChange(branchAdmin, 'GRANT', staff, checker, NOW).code).toBe('BEYOND_ADMIN_SCOPE');
    const inDel = { ...checker, scope: { ...ANY_SCOPE, branchId: 'DEL' } };
    expect(decideAccessChange(branchAdmin, 'GRANT', staff, inDel, NOW).decision).toBe('ALLOW');
  });

  it('client users can only get read-only access to their own client', () => {
    const tom = { id: 'tom', name: 'Tom', type: 'CLIENT' as const, clientId: 'ACME' };
    expect(decideAccessChange(admin, 'GRANT', tom, { ...checker, scope: { ...ANY_SCOPE, clientId: 'ACME' } }, NOW).code).toBe('TARGET_NOT_ALLOWED');
    const viewer = { roleId: 'CLIENT_VIEWER', rolePermissions: ['job.view'], roleIsPrivileged: false, scope: { ...ANY_SCOPE, clientId: 'ACME' } };
    expect(decideAccessChange(admin, 'GRANT', tom, viewer, NOW).decision).toBe('ALLOW');
  });
});
