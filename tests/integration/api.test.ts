/**
 * End-to-end tests through the HTTP API (Supertest -> Express -> services -> engine -> Postgres).
 * Numbered comments map to the required test list in the brief.
 * Not covered here (deferred, see docs/DESIGN.md): #20 overdue escalation, #21 notifications.
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { performJobAction } from '../../src/services/jobService';
import { api, app, makeJob, prisma, resetDb } from '../helpers';

beforeAll(async () => {
  await resetDb();
});

const historyActions = async (jobId: string) =>
  (await prisma.jobHistory.findMany({ where: { jobId }, orderBy: { createdAt: 'asc' } })).map((h) => h.action);

describe('maker-checker and scope', () => {
  it('#1 a maker cannot check a job they prepared, even with a covering CHECKER grant', async () => {
    // sarah: MAKER everywhere + CHECKER for ACME
    const job = await makeJob({ clientId: 'ACME', branchId: 'BOM', direction: 'IMPORT' }, { preparer: 'sarah' });
    const res = await api.post('sarah', `/jobs/${job.reference}/check`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SOD_VIOLATION');
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).stage).toBe('PREPARED');
  });

  it('#2 a checker whose scope matches client, branch and direction is allowed', async () => {
    // raj: CHECKER for ACME / BOM / IMPORT only
    const job = await makeJob({ clientId: 'ACME', branchId: 'BOM', direction: 'IMPORT' }, { preparer: 'alice' });
    const res = await api.post('raj', `/jobs/${job.reference}/check`);
    expect(res.status).toBe(200);
    expect(res.body.job.stage).toBe('CHECKED');
    const row = await prisma.jobHistory.findFirstOrThrow({ where: { jobId: job.id, action: 'CHECK' } });
    expect(row.actorId).toBe('raj');
    expect(row.grantId).not.toBeNull(); // the authority used is recorded
  });

  it.each([
    ['#3 client', { clientId: 'BLUESKY', branchId: 'BOM', direction: 'IMPORT' as const }],
    ['#4 branch', { clientId: 'ACME', branchId: 'DEL', direction: 'IMPORT' as const }],
    ['#5 direction', { clientId: 'ACME', branchId: 'BOM', direction: 'EXPORT' as const }],
  ])('%s mismatch: the checker is denied', async (_label, attrs) => {
    const job = await makeJob(attrs, { preparer: 'alice' });
    const res = await api.post('raj', `/jobs/${job.reference}/check`);
    // raj cannot even see jobs outside his scope, so he gets 404 rather than learning they exist.
    expect([403, 404]).toContain(res.status);
    const explained = await api.post('anita', '/authorization/check', { action: 'job.check', jobId: job.reference, userIds: ['raj'] });
    expect(explained.status).toBe(200);
    expect(explained.body.decisions[0].decision).toBe('DENY');
    expect(explained.body.decisions[0].code).toBe('SCOPE_MISMATCH');
  });
});

describe('absence and delegation', () => {
  it('#6 an absent user cannot perform normal work (but can still view)', async () => {
    // priya (CHECKER for CORAL) is on annual leave in the seed
    const job = await makeJob({ clientId: 'CORAL', branchId: 'MAA', direction: 'IMPORT' }, { preparer: 'alice' });
    const res = await api.post('priya', `/jobs/${job.reference}/check`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACTOR_ABSENT');
    expect((await api.get('priya', `/jobs/${job.reference}`)).status).toBe(200);
  });

  it('#7 a valid delegate can act within the delegated scope, and history says so', async () => {
    // dev normally checks only EVEREST; priya delegated CHECKER for CORAL to him
    const job = await makeJob({ clientId: 'CORAL', branchId: 'MAA', direction: 'IMPORT' }, { preparer: 'alice' });
    const res = await api.post('dev', `/jobs/${job.reference}/check`);
    expect(res.status).toBe(200);
    const row = await prisma.jobHistory.findFirstOrThrow({ where: { jobId: job.id, action: 'CHECK' } });
    expect(row).toMatchObject({ actorId: 'dev', via: 'DELEGATION', onBehalfOfId: 'priya', delegationId: 'delegation_priya_dev' });
  });

  it('#7b the delegate cannot act outside the delegated scope', async () => {
    // priya also checks DELTA, but only CORAL was delegated
    const job = await makeJob({ clientId: 'DELTA', branchId: 'MAA', direction: 'IMPORT' }, { preparer: 'alice' });
    const res = await api.post('dev', `/jobs/${job.reference}/check`);
    expect([403, 404]).toContain(res.status);
  });

  it('#8 an expired delegation is denied', async () => {
    const job = await makeJob({ clientId: 'CORAL', branchId: 'MAA', direction: 'IMPORT' }, { preparer: 'alice' });
    await prisma.delegation.update({ where: { id: 'delegation_priya_dev' }, data: { validUntil: new Date(Date.now() - 60_000) } });
    try {
      const res = await api.post('dev', `/jobs/${job.reference}/check`);
      expect([403, 404]).toContain(res.status);
      expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).stage).toBe('PREPARED');
    } finally {
      await prisma.delegation.update({ where: { id: 'delegation_priya_dev' }, data: { validUntil: new Date(Date.now() + 7 * 86_400_000) } });
    }
  });
});

describe('filed jobs and operations admin', () => {
  it('#9 a normal user cannot modify a filed job', async () => {
    const edit = await api.patch('alice', '/jobs/NF-DEMO-04', { notes: 'sneaky change' });
    expect(edit.status).toBe(403);
    expect(edit.body.error.code).toMatch(/FILED_LOCKED|WRONG_STAGE/);
    const cancel = await api.post('sarah', '/jobs/NF-DEMO-04/cancel', { reason: 'not my call' });
    expect(cancel.status).toBe(403);
    expect((await prisma.job.findUniqueOrThrow({ where: { reference: 'NF-DEMO-04' } })).stage).toBe('FILED');
  });

  it('#10 an in-scope Operations Admin can cancel a filed job, only with a reason', async () => {
    const noReason = await api.post('omar', '/jobs/NF-DEMO-04/cancel', {});
    expect(noReason.status).toBe(400);

    const outOfScope = await api.post('olivia', '/jobs/NF-DEMO-04/cancel', { reason: 'Duplicate filing' }); // olivia: OPS_ADMIN for DEL only
    expect([403, 404]).toContain(outOfScope.status);

    const ok = await api.post('omar', '/jobs/NF-DEMO-04/cancel', { reason: 'Duplicate filing' });
    expect(ok.status).toBe(200);
    expect(ok.body.job.stage).toBe('CANCELLED');
    const row = await prisma.jobHistory.findFirstOrThrow({ where: { job: { reference: 'NF-DEMO-04' }, action: 'CANCEL' } });
    expect(row).toMatchObject({ actorId: 'omar', reason: 'Duplicate filing', fromStage: 'FILED' });
  });

  it('#10b an admin who filed the job cannot cancel it', async () => {
    // omar filed NF-DEMO-08 himself
    const res = await api.post('omar', '/jobs/NF-DEMO-08/cancel', { reason: 'Changing my own filing' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SOD_VIOLATION');
  });

  it('#11 an in-scope Operations Admin can reopen with a reason', async () => {
    const res = await api.post('omar', '/jobs/NF-DEMO-04/reopen', { reason: 'Refile with corrected value' });
    expect(res.status).toBe(200);
    expect(res.body.job.stage).toBe('REOPENED');
    expect(await historyActions(res.body.job.id)).toEqual(expect.arrayContaining(['FILE', 'CANCEL', 'REOPEN']));
  });
});

describe('access administration', () => {
  it('#12 an admin cannot escalate their own privileges, and the attempt is audited', async () => {
    const res = await api.post('anita', '/access-grants', { userId: 'anita', roleId: 'FILER', reason: 'I need to file today' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SELF_ESCALATION');
    expect(await prisma.accessGrant.count({ where: { userId: 'anita', roleId: 'FILER' } })).toBe(0);
    const audit = await prisma.accessAuditLog.findFirst({ where: { actorId: 'anita', targetUserId: 'anita', outcome: 'DENIED' } });
    expect(audit?.code).toBe('SELF_ESCALATION');
  });

  it('#12b a branch-scoped access admin cannot grant outside their branch', async () => {
    // bharat: ACCESS_ADMIN for DEL only
    const res = await api.post('bharat', '/access-grants', { userId: 'alice', roleId: 'CHECKER', branchId: 'BOM', reason: 'Extra checker capacity' });
    expect(res.status).toBe(403);
  });

  it('#12c a grant takes effect immediately and a revoke removes it immediately', async () => {
    const job = await makeJob({ clientId: 'INDIGO', branchId: 'BLR', direction: 'EXPORT' }, { preparer: 'alice' });
    expect([403, 404]).toContain((await api.post('raj', `/jobs/${job.reference}/check`)).status);

    const grant = await api.post('anita', '/access-grants', { userId: 'raj', roleId: 'CHECKER', clientId: 'INDIGO', reason: 'Covering Indigo' });
    expect(grant.status).toBe(201);
    const check = await api.post('raj', `/jobs/${job.reference}/check`);
    expect(check.status).toBe(200);

    expect((await api.post('anita', `/access-grants/${grant.body.grant.id}/revoke`, { reason: 'Cover ended' })).status).toBe(200);
    const job2 = await makeJob({ clientId: 'INDIGO', branchId: 'BLR', direction: 'EXPORT' }, { preparer: 'alice' });
    expect([403, 404]).toContain((await api.post('raj', `/jobs/${job2.reference}/check`)).status);
  });
});

describe('time: historical access', () => {
  it('#15 explaining access at a past time uses the policy that was valid then', async () => {
    // lena held CHECKER for FALCON until 2026-10-01, when it was revoked.
    const job = await prisma.job.create({
      data: {
        reference: 'NF-T-HIST-1', clientId: 'FALCON', branchId: 'BOM', direction: 'IMPORT', mode: 'AIR',
        stage: 'PREPARED', stageEnteredAt: new Date('2026-09-02T00:00:00Z'), consignee: 'X', weightKg: 1, valueInr: 1,
        createdById: 'parser', createdAt: new Date('2026-09-01T00:00:00Z'),
      },
    });
    await prisma.jobHistory.createMany({
      data: [
        { jobId: job.id, actorId: 'parser', via: 'DIRECT', action: 'CREATE', fromStage: null, toStage: 'CONFIRMED', createdAt: new Date('2026-09-01T00:00:00Z') },
        { jobId: job.id, actorId: 'alice', via: 'DIRECT', action: 'PREPARE', fromStage: 'CONFIRMED', toStage: 'PREPARED', createdAt: new Date('2026-09-02T00:00:00Z') },
      ],
    });

    const then = await api.post('anita', '/authorization/check', { action: 'job.check', jobId: job.reference, userIds: ['lena'], at: '2026-09-15T00:00:00Z' });
    expect(then.status).toBe(200);
    expect(then.body.decisions[0].decision).toBe('ALLOW');

    const now = await api.post('anita', '/authorization/check', { action: 'job.check', jobId: job.reference, userIds: ['lena'] });
    expect(now.body.decisions[0].decision).toBe('DENY');

    const who = await api.get('anita', `/jobs/${job.reference}/who-could-act?action=job.check&at=2026-09-15T00:00:00Z`);
    expect(who.status).toBe(200);
    const ids = who.body.couldAct[0].couldAct.map((u: { userId: string }) => u.userId);
    expect(ids).toContain('lena');
    expect(ids).not.toContain('alice'); // the preparer is excluded
  });
});

describe('queues and automation', () => {
  it('#16 waiting-for-me returns only jobs the engine would let me act on', async () => {
    for (const user of ['raj', 'sarah', 'fiona', 'dev']) {
      const res = await api.get(user, '/jobs/waiting-for-me?limit=200');
      expect(res.status).toBe(200);
      for (const item of res.body.items) {
        const detail = await api.get(user, `/jobs/${item.id}`);
        expect(detail.body.allowedActions, `${user} / ${item.reference}`).toContain(item.nextAction);
      }
    }
    // sarah prepared NF-DEMO-02, so it must not be in her check queue
    const sarah = await api.get('sarah', '/jobs/waiting-for-me?limit=200');
    expect(sarah.body.items.map((j: { reference: string }) => j.reference)).not.toContain('NF-DEMO-02');
    // absent priya has nothing waiting
    expect((await api.get('priya', '/jobs/waiting-for-me')).body.total).toBe(0);
  });

  it('#17 + #18 automation routes a prepared job to an eligible checker who is not the preparer', async () => {
    const job = await makeJob({ clientId: 'ACME', branchId: 'BOM', direction: 'IMPORT' }, { preparer: 'sarah' });
    expect(job.assigneeId).toBeTruthy();
    expect(job.assigneeId).not.toBe('sarah');
    const explained = await api.post('anita', '/authorization/check', { action: 'job.check', jobId: job.reference, userIds: [job.assigneeId!] });
    expect(explained.body.decisions[0].decision).toBe('ALLOW');
    const assign = await prisma.jobHistory.findFirstOrThrow({ where: { jobId: job.id, action: 'ASSIGN' }, orderBy: { createdAt: 'desc' } });
    expect(assign.actorId).toBe('automation');
  });

  it('#19 absence reassignment hands the job only to someone the engine allows', async () => {
    // CORAL / MAA: dev (delegate) and karan (CHECKER for MAA) are both eligible.
    const job = await makeJob({ clientId: 'CORAL', branchId: 'MAA', direction: 'IMPORT' }, { preparer: 'alice' });
    expect(['dev', 'karan']).toContain(job.assigneeId);
    const original = job.assigneeId!;
    await absent(original);
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.assigneeId).toBeTruthy();
    expect(after.assigneeId).not.toBe(original);
    const explained = await api.post('anita', '/authorization/check', { action: 'job.check', jobId: job.reference, userIds: [after.assigneeId!] });
    expect(explained.body.decisions[0].decision).toBe('ALLOW');
    await prisma.absence.deleteMany({ where: { userId: original } });
  });

  it('#19b when nobody else is eligible the job is left unassigned and flagged, not given to a random person', async () => {
    // CORAL / CCU: only dev (via priya's delegation) can check it; priya herself is absent.
    const job = await makeJob({ clientId: 'CORAL', branchId: 'CCU', direction: 'IMPORT' }, { preparer: 'alice' });
    expect(job.assigneeId).toBe('dev');
    await absent('dev');
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.assigneeId).toBeNull();
    const log = await prisma.automationLog.findFirst({ where: { jobId: job.id, outcome: 'FAILED' }, orderBy: { createdAt: 'desc' } });
    expect(log).not.toBeNull();
    await prisma.absence.deleteMany({ where: { userId: 'dev' } });
  });
});

describe('changed responsibility', () => {
  it('revoking a grant mid-job takes effect immediately and moves their in-flight work to someone eligible', async () => {
    const job = await makeJob({ clientId: 'ACME', branchId: 'BOM', direction: 'IMPORT' }, { preparer: 'alice' });
    const assigned = await api.post('omar', `/jobs/${job.reference}/assign`, { assigneeId: 'raj', reason: 'Raj knows this consignee' });
    expect(assigned.status).toBe(200);
    expect(assigned.body.job.assigneeId).toBe('raj');

    const rajGrant = await prisma.accessGrant.findFirstOrThrow({ where: { userId: 'raj', roleId: 'CHECKER', revokedAt: null } });
    const revoke = await api.post('anita', `/access-grants/${rajGrant.id}/revoke`, { reason: 'Moved to the export desk' });
    expect(revoke.status).toBe(200);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.assigneeId).not.toBe('raj');
    if (after.assigneeId) {
      const ok = await api.post('anita', '/authorization/check', { action: 'job.check', jobId: job.reference, userIds: [after.assigneeId] });
      expect(ok.body.decisions[0].decision).toBe('ALLOW');
    }
    // raj's still-valid token no longer lets him act
    expect([403, 404]).toContain((await api.post('raj', `/jobs/${job.reference}/check`)).status);
    // and his past actions keep pointing at the grant he used at the time
    expect((await prisma.accessGrant.findUniqueOrThrow({ where: { id: rajGrant.id } })).revokedAt).not.toBeNull();

    // restore for the tests that follow
    await prisma.accessGrant.update({ where: { id: rajGrant.id }, data: { revokedAt: null, revokedById: null, revokeReason: null } });
  });
});

async function absent(userId: string) {
  const res = await api.post('anita', `/users/${userId}/absences`, {
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    reason: 'Sick leave',
  });
  expect(res.status).toBe(201);
}

describe('service identities', () => {
  // The parser has no job.view, so a denied action returns 404 (existence is not revealed).
  // We assert that nothing changed, and read the real reason through the explain API.
  const denied = { status: expect.any(Number) };
  const parserDecision = async (action: string, ref: string) =>
    (await api.post('anita', '/authorization/check', { action, jobId: ref, userIds: ['parser'] })).body.decisions[0];

  it('#13 the parser cannot check or file jobs', async () => {
    const job = await makeJob({ clientId: 'ACME', branchId: 'BOM', direction: 'IMPORT' }, { preparer: 'alice' });
    await expect(performJobAction('parser', job.reference, 'job.check')).rejects.toMatchObject(denied);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).stage).toBe('PREPARED');
    expect(await parserDecision('job.check', job.reference)).toMatchObject({ decision: 'DENY', code: 'NO_PERMISSION' });

    await api.post('raj', `/jobs/${job.reference}/check`);
    await expect(performJobAction('parser', job.reference, 'job.file')).rejects.toMatchObject(denied);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).stage).toBe('CHECKED');
    expect(await parserDecision('job.file', job.reference)).toMatchObject({ decision: 'DENY', code: 'NO_PERMISSION' });
  });

  it('#14 the parser can create jobs and update imported data, but only before preparation', async () => {
    const job = await makeJob({ clientId: 'GLOBEX', branchId: 'BLR', direction: 'EXPORT' });
    expect(job.createdById).toBe('parser');
    const upd = await performJobAction('parser', job.reference, 'job.import_update', { changes: { weightKg: 250 } });
    expect(Number(upd.job.weightKg)).toBe(250);

    await performJobAction('alice', job.reference, 'job.prepare');
    await expect(performJobAction('parser', job.reference, 'job.import_update', { changes: { weightKg: 999 } })).rejects.toMatchObject(denied);
    expect(Number((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).weightKg)).toBe(250);
    expect(await parserDecision('job.import_update', job.reference)).toMatchObject({ decision: 'DENY', code: 'WRONG_STAGE' });
  });
});

describe('concurrency', () => {
  it('#23 two simultaneous checks: exactly one succeeds, one CHECK in history', async () => {
    // raj and karan can both check ACME/BOM/IMPORT jobs
    const job = await makeJob({ clientId: 'ACME', branchId: 'BOM', direction: 'IMPORT' }, { preparer: 'alice' });
    const results = await Promise.all([api.post('raj', `/jobs/${job.reference}/check`), api.post('karan', `/jobs/${job.reference}/check`)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    expect((await historyActions(job.id)).filter((a) => a === 'CHECK')).toHaveLength(1);
  });
});

describe('authentication and API protection', () => {
  it('#24 unauthenticated, invalid and deactivated callers are rejected', async () => {
    expect((await request(app).get('/jobs')).status).toBe(401);
    expect((await request(app).get('/jobs').set({ Authorization: 'Bearer not-a-token' })).status).toBe(401);
    expect((await api.get('eric', '/jobs')).status).toBe(401); // eric is INACTIVE: a still-valid token stops working
  });

  it('#24b login works with the right password and does not leak which emails exist', async () => {
    const ok = await request(app).post('/auth/login').send({ email: 'alice@nfpl.test', password: 'Password123!' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    const badPw = await request(app).post('/auth/login').send({ email: 'alice@nfpl.test', password: 'wrong' });
    const noUser = await request(app).post('/auth/login').send({ email: 'nobody@nfpl.test', password: 'wrong' });
    expect(badPw.status).toBe(401);
    expect(noUser.body).toEqual(badPw.body);
  });

  it('#24c client users see only their own client and cannot reach admin APIs', async () => {
    const list = await api.get('tom', '/jobs?limit=200');
    expect(list.status).toBe(200);
    expect(new Set(list.body.items.map((j: { clientId: string }) => j.clientId))).toEqual(new Set(['ACME']));
    const other = await prisma.job.findFirstOrThrow({ where: { clientId: 'BLUESKY' } });
    expect((await api.get('tom', `/jobs/${other.reference}`)).status).toBe(404);
    expect((await api.get('tom', '/access-grants')).status).toBe(403);
    expect((await api.post('tom', '/authorization/check', { action: 'job.check', jobId: 'NF-DEMO-01', userIds: ['raj'] })).status).toBe(403);
  });
});
