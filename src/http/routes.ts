/**
 * HTTP routes. Deliberately thin: validate input (zod), take the actor from the JWT
 * (never from the body), call a service, return JSON. No permission logic here.
 */
import { Router } from 'express';
import { z } from 'zod';
import { describeUserAccess, createDelegation, createGrant, listDelegations, listGrants, listUsers, readAccessAudit, readAutomationLog, recordAbsence, revokeDelegation, revokeGrant, setUserStatus } from '../services/accessService';
import { explain, getJobHistory, whoCouldAct } from '../services/historyService';
import { createJob, getJobForUser, listJobs, performJobAction } from '../services/jobService';
import { waitingForMe } from '../services/queueService';
import { prisma } from '../db';
import type { JobAction } from '../domain/permissions';

const direction = z.enum(['IMPORT', 'EXPORT']);
const mode = z.enum(['AIR', 'FCL', 'LCL']);
const stage = z.enum(['CONFIRMED', 'PREPARED', 'CHECKED', 'FILED', 'CANCELLED', 'REOPENED']);
const reason = z.string().trim().min(3, 'A reason of at least 3 characters is required').max(500);
const date = z.coerce.date();
const limit = z.coerce.number().int().min(1).max(200).default(50);
const scopeFields = {
  clientId: z.string().nullish(),
  branchId: z.string().nullish(),
  direction: direction.nullish(),
  mode: mode.nullish(),
};

const me = (req: { userId?: string }) => req.userId!; // set by requireAuth, never by the client

export const apiRouter = Router();

// ------------------------------------------------------------------ me
apiRouter.get('/auth/me', async (req, res) => {
  res.json(await describeUserAccess(me(req)));
});

// ------------------------------------------------------------------ jobs
apiRouter.get('/jobs', async (req, res) => {
  const q = z.object({ stage: stage.optional(), clientId: z.string().optional(), branchId: z.string().optional(), direction: direction.optional(), mode: mode.optional(), assigneeId: z.string().optional(), cursor: z.string().optional(), limit }).parse(req.query);
  res.json(await listJobs(me(req), q));
});

// Must be registered before /jobs/:id so "waiting-for-me" is not treated as an id.
apiRouter.get('/jobs/waiting-for-me', async (req, res) => {
  const q = z.object({ cursor: z.string().optional(), limit }).parse(req.query);
  res.json(await waitingForMe(me(req), q));
});

apiRouter.post('/jobs', async (req, res) => {
  const body = z.object({
    reference: z.string().trim().min(3).max(40),
    clientId: z.string(),
    branchId: z.string(),
    direction,
    mode,
    consignee: z.string().trim().min(1).max(200),
    weightKg: z.number().positive(),
    valueInr: z.number().nonnegative(),
    notes: z.string().max(2000).nullish(),
  }).parse(req.body);
  const { job } = await createJob(me(req), body);
  res.status(201).json(job);
});

apiRouter.get('/jobs/:id', async (req, res) => {
  res.json(await getJobForUser(me(req), req.params.id));
});

apiRouter.patch('/jobs/:id', async (req, res) => {
  const changes = z.object({
    consignee: z.string().trim().min(1).max(200).optional(),
    weightKg: z.number().positive().optional(),
    valueInr: z.number().nonnegative().optional(),
    notes: z.string().max(2000).nullable().optional(),
  }).strict().parse(req.body);
  res.json(await performJobAction(me(req), req.params.id, 'job.edit', { changes }));
});

apiRouter.get('/jobs/:id/history', async (req, res) => {
  res.json(await getJobHistory(me(req), req.params.id));
});

apiRouter.get('/jobs/:id/who-could-act', async (req, res) => {
  const q = z.object({ at: date.default(() => new Date()), action: z.string().optional() }).parse(req.query);
  res.json(await whoCouldAct(me(req), req.params.id, q.at, q.action));
});

// Workflow transitions. Each maps to exactly one permission; there is no "set stage" endpoint.
const transitions: Record<string, { action: (stage: string) => JobAction; needsReason: boolean }> = {
  prepare: { action: () => 'job.prepare', needsReason: false },
  check: { action: () => 'job.check', needsReason: false },
  reject: { action: () => 'job.reject', needsReason: true },
  file: { action: () => 'job.file', needsReason: false },
  // Cancelling a FILED job is a different, more sensitive permission than cancelling a draft.
  cancel: { action: (s) => (s === 'FILED' ? 'job.cancel_filed' : 'job.cancel'), needsReason: true },
  reopen: { action: () => 'job.reopen', needsReason: true },
};

for (const [name, t] of Object.entries(transitions)) {
  apiRouter.post(`/jobs/:id/${name}`, async (req, res) => {
    const body = z.object({ reason: t.needsReason ? reason : reason.optional() }).parse(req.body ?? {});
    const job = await prisma.job.findFirst({ where: { OR: [{ id: req.params.id }, { reference: req.params.id }] }, select: { stage: true } });
    const action = t.action(job?.stage ?? '');
    res.json(await performJobAction(me(req), req.params.id, action, { reason: body.reason }));
  });
}

apiRouter.post('/jobs/:id/assign', async (req, res) => {
  const body = z.object({ assigneeId: z.string().nullable(), reason }).parse(req.body);
  res.json(await performJobAction(me(req), req.params.id, 'job.assign', body));
});

// ------------------------------------------------------------------ authorization
apiRouter.post('/authorization/check', async (req, res) => {
  const body = z.object({ action: z.string(), jobId: z.string(), userIds: z.array(z.string()).max(20).optional(), at: date.optional() }).parse(req.body);
  res.json(await explain(me(req), body));
});

// ------------------------------------------------------------------ access management
apiRouter.get('/access-grants', async (req, res) => {
  const q = z.object({ userId: z.string().optional() }).parse(req.query);
  res.json(await listGrants(me(req), q.userId));
});

apiRouter.post('/access-grants', async (req, res) => {
  const body = z.object({ userId: z.string(), roleId: z.string(), ...scopeFields, validFrom: date.optional(), validUntil: date.nullish(), reason }).parse(req.body);
  res.status(201).json(await createGrant(me(req), body));
});

apiRouter.post('/access-grants/:id/revoke', async (req, res) => {
  const body = z.object({ reason }).parse(req.body);
  res.json(await revokeGrant(me(req), req.params.id, body.reason));
});

apiRouter.get('/delegations', async (req, res) => {
  res.json(await listDelegations(me(req)));
});

apiRouter.post('/delegations', async (req, res) => {
  const body = z.object({ delegatorId: z.string(), delegateId: z.string(), roleId: z.string(), ...scopeFields, validFrom: date.optional(), validUntil: date, reason }).parse(req.body);
  res.status(201).json(await createDelegation(me(req), body));
});

apiRouter.post('/delegations/:id/revoke', async (req, res) => {
  const body = z.object({ reason }).parse(req.body);
  res.json(await revokeDelegation(me(req), req.params.id, body.reason));
});

apiRouter.get('/users', async (req, res) => {
  res.json(await listUsers(me(req)));
});

apiRouter.post('/users/:id/absences', async (req, res) => {
  const body = z.object({ startsAt: date, endsAt: date, reason }).parse(req.body);
  res.status(201).json(await recordAbsence(me(req), req.params.id, body));
});

apiRouter.patch('/users/:id/status', async (req, res) => {
  const body = z.object({ status: z.enum(['ACTIVE', 'INACTIVE']), reason }).parse(req.body);
  res.json(await setUserStatus(me(req), req.params.id, body.status, body.reason));
});

apiRouter.get('/roles', async (_req, res) => {
  res.json(await prisma.role.findMany({ orderBy: { id: 'asc' } }));
});

// ------------------------------------------------------------------ audit
apiRouter.get('/audit/access', async (req, res) => {
  const q = z.object({ userId: z.string().optional(), limit }).parse(req.query);
  res.json(await readAccessAudit(me(req), q));
});

apiRouter.get('/audit/automation', async (req, res) => {
  const q = z.object({ jobId: z.string().optional(), limit }).parse(req.query);
  res.json(await readAutomationLog(me(req), q));
});
