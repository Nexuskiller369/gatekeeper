/**
 * Deliberate sample data. Every awkward case the brief asks for is here on purpose:
 *  - Sarah: Maker everywhere, Checker for only two clients
 *  - Raj: Checker for one client, one branch, imports only
 *  - Priya: absent right now; Dev holds a time-boxed delegation of her CORAL checking
 *  - Tom / Clara: client-side users
 *  - Anita (Access Admin), Bharat (Access Admin for Delhi only)
 *  - Omar (Ops Admin + Filer), Olivia (Ops Admin for Delhi only)
 *  - Lena: had a Checker grant that was revoked on 2026-10-01 (history questions)
 *  - Eric: inactive ex-employee whose old grant still exists
 *  - parser / automation: non-human service identities
 * Jobs are generated with a fixed random seed, so the data is the same on every run.
 */
import bcrypt from 'bcryptjs';
import type { Direction, Mode, Prisma, PrismaClient, Stage, UserType } from '@prisma/client';
import { scopeMatches, toScope, type JobAttributes, type Scope } from '../authz/scope';

export const DEMO_PASSWORD = 'Password123!';
const SEED_EPOCH = new Date('2026-01-01T00:00:00Z');
const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const BRANCHES = [
  { id: 'BOM', name: 'Mumbai' },
  { id: 'DEL', name: 'Delhi' },
  { id: 'MAA', name: 'Chennai' },
  { id: 'BLR', name: 'Bengaluru' },
  { id: 'CCU', name: 'Kolkata' },
];

export const CLIENTS = [
  { id: 'ACME', name: 'Acme Pharma' },
  { id: 'BLUESKY', name: 'Bluesky Electronics' },
  { id: 'CORAL', name: 'Coral Textiles' },
  { id: 'DELTA', name: 'Delta Auto Parts' },
  { id: 'EVEREST', name: 'Everest Foods' },
  { id: 'FALCON', name: 'Falcon Chemicals' },
  { id: 'GLOBEX', name: 'Globex Machinery' },
  { id: 'HORIZON', name: 'Horizon Apparel' },
  { id: 'INDIGO', name: 'Indigo Furniture' },
  { id: 'JUPITER', name: 'Jupiter Steel' },
];

export const ROLES = [
  { id: 'MAKER', name: 'Maker', description: 'Prepares jobs and edits their data before filing', permissions: ['job.view', 'job.edit', 'job.prepare', 'job.cancel'], isPrivileged: false },
  { id: 'CHECKER', name: 'Checker', description: 'Reviews prepared jobs: approves (check) or sends back (reject)', permissions: ['job.view', 'job.check', 'job.reject'], isPrivileged: false },
  { id: 'FILER', name: 'Filer', description: 'Files checked jobs with customs', permissions: ['job.view', 'job.file'], isPrivileged: false },
  { id: 'VIEWER', name: 'Internal viewer', description: 'Read-only visibility, e.g. management', permissions: ['job.view'], isPrivileged: false },
  { id: 'CLIENT_VIEWER', name: 'Client viewer', description: "A client's employee following their own shipments", permissions: ['job.view'], isPrivileged: false },
  { id: 'OPS_ADMIN', name: 'Operations admin', description: 'Cancels/reopens filed jobs (with reason) and reassigns stuck jobs', permissions: ['job.view', 'job.cancel', 'job.cancel_filed', 'job.reopen', 'job.assign'], isPrivileged: true },
  { id: 'ACCESS_ADMIN', name: 'Access admin', description: 'Manages who has what; cannot change their own access', permissions: ['access.manage', 'access.explain', 'audit.view'], isPrivileged: true },
  { id: 'SYSTEM_PARSER', name: 'Overnight parser', description: 'Creates jobs and updates its own imported fields on unprepared jobs', permissions: ['job.create', 'job.import_update'], isPrivileged: true },
  { id: 'SYSTEM_AUTOMATION', name: 'Workflow automation', description: 'Routes jobs to eligible people', permissions: ['job.view', 'job.assign'], isPrivileged: true },
];

interface SeedGrant {
  roleId: string;
  scope?: Partial<Scope>;
  validFrom?: Date;
  revokedAt?: Date;
  revokeReason?: string;
}

interface SeedUser {
  id: string;
  name: string;
  type: UserType;
  clientId?: string;
  status?: 'ACTIVE' | 'INACTIVE';
  login?: boolean;
  grants: SeedGrant[];
}

export const USERS: SeedUser[] = [
  { id: 'anita', name: 'Anita Rao', type: 'STAFF', grants: [{ roleId: 'ACCESS_ADMIN' }] },
  { id: 'bharat', name: 'Bharat Iyer', type: 'STAFF', grants: [{ roleId: 'ACCESS_ADMIN', scope: { branchId: 'DEL' } }] },
  { id: 'omar', name: 'Omar Khan', type: 'STAFF', grants: [{ roleId: 'OPS_ADMIN' }, { roleId: 'FILER' }] },
  { id: 'olivia', name: "Olivia D'Souza", type: 'STAFF', grants: [{ roleId: 'OPS_ADMIN', scope: { branchId: 'DEL' } }] },
  { id: 'alice', name: 'Alice Fernandes', type: 'STAFF', grants: [{ roleId: 'MAKER' }] },
  {
    id: 'sarah', name: 'Sarah Thomas', type: 'STAFF',
    grants: [{ roleId: 'MAKER' }, { roleId: 'CHECKER', scope: { clientId: 'ACME' } }, { roleId: 'CHECKER', scope: { clientId: 'BLUESKY' } }],
  },
  { id: 'raj', name: 'Raj Malhotra', type: 'STAFF', grants: [{ roleId: 'CHECKER', scope: { clientId: 'ACME', branchId: 'BOM', direction: 'IMPORT' } }] },
  { id: 'priya', name: 'Priya Nair', type: 'STAFF', grants: [{ roleId: 'CHECKER', scope: { clientId: 'CORAL' } }, { roleId: 'CHECKER', scope: { clientId: 'DELTA' } }] },
  { id: 'dev', name: 'Dev Patel', type: 'STAFF', grants: [{ roleId: 'CHECKER', scope: { clientId: 'EVEREST' } }] },
  { id: 'meera', name: 'Meera Joshi', type: 'STAFF', grants: [{ roleId: 'CHECKER', scope: { branchId: 'DEL' } }] },
  {
    id: 'karan', name: 'Karan Singh', type: 'STAFF',
    grants: [{ roleId: 'CHECKER', scope: { branchId: 'BOM' } }, { roleId: 'CHECKER', scope: { branchId: 'BLR' } }, { roleId: 'CHECKER', scope: { branchId: 'MAA' } }],
  },
  { id: 'fiona', name: 'Fiona Pinto', type: 'STAFF', grants: [{ roleId: 'FILER' }] },
  { id: 'farhan', name: 'Farhan Ali', type: 'STAFF', grants: [{ roleId: 'FILER', scope: { branchId: 'BOM' } }] },
  { id: 'vikram', name: 'Vikram Reddy', type: 'STAFF', grants: [{ roleId: 'MAKER', scope: { branchId: 'MAA' } }] },
  {
    id: 'nisha', name: 'Nisha Gupta', type: 'STAFF',
    grants: [{ roleId: 'MAKER', scope: { clientId: 'GLOBEX' } }, { roleId: 'MAKER', scope: { clientId: 'HORIZON' } }, { roleId: 'CHECKER', scope: { clientId: 'FALCON' } }],
  },
  {
    id: 'lena', name: 'Lena Kapoor', type: 'STAFF',
    grants: [
      { roleId: 'CHECKER', scope: { clientId: 'FALCON' }, revokedAt: new Date('2026-10-01T00:00:00Z'), revokeReason: 'Moved to the Kolkata maker team' },
      { roleId: 'MAKER', scope: { branchId: 'CCU' }, validFrom: new Date('2026-10-01T00:00:00Z') },
    ],
  },
  { id: 'eric', name: 'Eric Mendes', type: 'STAFF', status: 'INACTIVE', grants: [{ roleId: 'MAKER' }] },
  { id: 'ian', name: 'Ian Chatterjee', type: 'STAFF', grants: [{ roleId: 'VIEWER' }] },
  { id: 'tom', name: 'Tom Baker (Acme Pharma)', type: 'CLIENT', clientId: 'ACME', grants: [{ roleId: 'CLIENT_VIEWER', scope: { clientId: 'ACME' } }] },
  { id: 'clara', name: 'Clara Lim (Bluesky Electronics)', type: 'CLIENT', clientId: 'BLUESKY', grants: [{ roleId: 'CLIENT_VIEWER', scope: { clientId: 'BLUESKY' } }] },
  { id: 'parser', name: 'Overnight Parser', type: 'SERVICE', login: false, grants: [{ roleId: 'SYSTEM_PARSER' }] },
  { id: 'automation', name: 'Workflow Automation', type: 'SERVICE', login: false, grants: [{ roleId: 'SYSTEM_AUTOMATION' }] },
];

export const emailFor = (id: string) => `${id}@nfpl.test`;

// ---------------------------------------------------------------- deterministic randomness

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONSIGNEES = ['Hindustan Traders', 'Sagar Imports', 'Orion Logistics', 'Western Distributors', 'Kaveri Exports', 'Nova Retail', 'Pioneer Agencies'];

/** Who in the seed holds `roleId` with a scope covering this job (ignores time, used only to build plausible history). */
function holders(roleId: string, job: JobAttributes, exclude: string[] = []): string[] {
  return USERS.filter(
    (u) =>
      u.status !== 'INACTIVE' &&
      !exclude.includes(u.id) &&
      u.grants.some((g) => g.roleId === roleId && !g.revokedAt && scopeMatches(toScope(g.scope ?? {}), job)),
  ).map((u) => u.id);
}

interface HistoryRow {
  jobId: string;
  actorId: string;
  via: string;
  action: string;
  fromStage: Stage | null;
  toStage: Stage | null;
  reason?: string;
  grantId?: string | null;
  createdAt: Date;
}

// ---------------------------------------------------------------- main

export async function seedDatabase(prisma: PrismaClient, opts: { jobCount?: number; now?: Date } = {}) {
  const jobCount = opts.jobCount ?? 300;
  const now = opts.now ?? new Date();
  const rand = mulberry32(42);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

  // Start from a clean slate (dev/test databases only).
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AutomationLog","AccessAuditLog","JobHistory","Job","Absence","Delegation","AccessGrant","User","Role","Client","Branch" CASCADE',
  );

  await prisma.branch.createMany({ data: BRANCHES });
  await prisma.client.createMany({ data: CLIENTS });
  await prisma.role.createMany({ data: ROLES });

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  await prisma.user.createMany({
    data: USERS.map((u) => ({
      id: u.id,
      name: u.name,
      email: emailFor(u.id),
      type: u.type,
      clientId: u.clientId ?? null,
      status: u.status ?? 'ACTIVE',
      passwordHash: u.login === false ? null : passwordHash,
    })),
  });

  // Grants (+ a bootstrap audit entry for each, so the access history starts complete).
  const grantIdByUserRole = new Map<string, string>(); // "user:role" -> first active grant id (for history attribution)
  const grantRows: Prisma.AccessGrantCreateManyInput[] = [];
  let gseq = 0;
  for (const u of USERS) {
    for (const g of u.grants) {
      const id = `grant_${String(++gseq).padStart(3, '0')}`;
      const scope = toScope(g.scope ?? {});
      grantRows.push({
        id,
        userId: u.id,
        roleId: g.roleId,
        ...scope,
        validFrom: g.validFrom ?? SEED_EPOCH,
        reason: 'Initial access (bootstrap)',
        grantedById: 'anita',
        createdAt: g.validFrom ?? SEED_EPOCH,
        revokedAt: g.revokedAt ?? null,
        revokedById: g.revokedAt ? 'anita' : null,
        revokeReason: g.revokeReason ?? null,
      });
      if (!g.revokedAt && !grantIdByUserRole.has(`${u.id}:${g.roleId}`)) grantIdByUserRole.set(`${u.id}:${g.roleId}`, id);
    }
  }
  await prisma.accessGrant.createMany({ data: grantRows });
  await prisma.accessAuditLog.createMany({
    data: grantRows.flatMap((g) => {
      const rows: Prisma.AccessAuditLogCreateManyInput[] = [
        { actorId: 'anita', targetUserId: g.userId, action: 'GRANT', outcome: 'ALLOWED', reason: 'Initial access (bootstrap)', details: { grantId: g.id, roleId: g.roleId }, createdAt: g.createdAt as Date },
      ];
      if (g.revokedAt) {
        rows.push({ actorId: 'anita', targetUserId: g.userId, action: 'REVOKE', outcome: 'ALLOWED', reason: g.revokeReason ?? null, details: { grantId: g.id }, createdAt: g.revokedAt as Date });
      }
      return rows;
    }),
  });

  // Priya is away this week; Dev covers her CORAL checking.
  await prisma.absence.create({
    data: { id: 'absence_priya', userId: 'priya', startsAt: new Date(now.getTime() - DAY), endsAt: new Date(now.getTime() + 7 * DAY), reason: 'Annual leave', createdById: 'anita' },
  });
  await prisma.delegation.create({
    data: {
      id: 'delegation_priya_dev', delegatorId: 'priya', delegateId: 'dev', roleId: 'CHECKER', clientId: 'CORAL',
      validFrom: new Date(now.getTime() - DAY), validUntil: new Date(now.getTime() + 7 * DAY),
      reason: 'Cover for Priya during annual leave', createdById: 'anita',
    },
  });

  // ------------------------------------------------------------ jobs
  const jobs: Prisma.JobCreateManyInput[] = [];
  const history: HistoryRow[] = [];
  const gid = (userId: string, roleId: string) => grantIdByUserRole.get(`${userId}:${roleId}`) ?? null;

  function buildJob(
    n: number,
    attrs: JobAttributes,
    target: Stage,
    fixed?: { reference: string; createdAt: Date; preparer?: string; checker?: string; filer?: string; assigneeId?: string },
  ) {
    const id = fixed ? `job_${fixed.reference.toLowerCase().replace(/[^a-z0-9]/g, '_')}` : `job_${String(n).padStart(6, '0')}`;
    const reference = fixed?.reference ?? `NF-${String(n).padStart(6, '0')}`;
    let t = fixed?.createdAt ?? new Date(now.getTime() - (5 + Math.floor(rand() * 55)) * DAY);
    const step = () => (t = new Date(t.getTime() + (2 + Math.floor(rand() * 20)) * HOUR));
    if (!fixed) rand(); // keep the PRNG sequence stable (was used for a creator coin-flip)
    // Only SYSTEM_PARSER holds job.create, so every job in the seed arrives via the parser.
    const creator = 'parser';
    history.push({ jobId: id, actorId: creator, via: 'DIRECT', action: 'CREATE', fromStage: null, toStage: 'CONFIRMED', grantId: gid(creator, 'SYSTEM_PARSER'), createdAt: t });
    let stage: Stage = 'CONFIRMED';
    const order: Stage[] = ['CONFIRMED', 'PREPARED', 'CHECKED', 'FILED'];
    const reach = target === 'CANCELLED' || target === 'REOPENED' ? 'FILED' : target;

    let preparer: string | undefined;
    let checker: string | undefined;
    let filer: string | undefined;
    for (const s of order.slice(1, order.indexOf(reach) + 1)) {
      if (s === 'PREPARED') {
        preparer = fixed?.preparer ?? pick(holders('MAKER', attrs).filter((u) => u !== 'eric'));
        if (!preparer) break;
        history.push({ jobId: id, actorId: preparer, via: 'DIRECT', action: 'PREPARE', fromStage: stage, toStage: 'PREPARED', grantId: gid(preparer, 'MAKER'), createdAt: step() });
      } else if (s === 'CHECKED') {
        const candidates = holders('CHECKER', attrs, [preparer!]);
        checker = fixed?.checker ?? (candidates.length ? pick(candidates) : undefined);
        if (!checker) break; // nobody could check it: leave it waiting
        history.push({ jobId: id, actorId: checker, via: 'DIRECT', action: 'CHECK', fromStage: stage, toStage: 'CHECKED', grantId: gid(checker, 'CHECKER'), createdAt: step() });
      } else if (s === 'FILED') {
        filer = fixed?.filer ?? pick(holders('FILER', attrs, ['omar']));
        history.push({ jobId: id, actorId: filer, via: 'DIRECT', action: 'FILE', fromStage: stage, toStage: 'FILED', grantId: gid(filer, 'FILER'), createdAt: step() });
      }
      stage = s;
    }
    if (stage === 'FILED' && (target === 'CANCELLED' || target === 'REOPENED')) {
      const action = target === 'CANCELLED' ? 'CANCEL' : 'REOPEN';
      const reason = target === 'CANCELLED' ? 'Shipment withdrawn by client' : 'Customs query: invoice value to be corrected';
      history.push({ jobId: id, actorId: 'omar', via: 'DIRECT', action, fromStage: 'FILED', toStage: target, reason, grantId: gid('omar', 'OPS_ADMIN'), createdAt: step() });
      stage = target;
    }
    jobs.push({
      id,
      reference,
      externalRef: `EXT-${reference}`,
      ...attrs,
      stage,
      stageEnteredAt: t,
      assigneeId: fixed?.assigneeId ?? null,
      consignee: pick(CONSIGNEES),
      weightKg: Math.round(rand() * 20000) / 10,
      valueInr: Math.round(rand() * 5_000_000),
      createdById: creator,
      createdAt: history.find((h) => h.jobId === id)!.createdAt,
    });
  }

  // Showcase jobs with stable references used in the README and demo.
  const demoT = new Date(now.getTime() - 3 * DAY);
  const demo = (ref: string, attrs: JobAttributes, target: Stage, extra: { preparer?: string; checker?: string; filer?: string; assigneeId?: string } = {}) =>
    buildJob(0, attrs, target, { reference: ref, createdAt: demoT, ...extra });
  const A = (clientId: string, branchId: string, direction: Direction, mode: Mode): JobAttributes => ({ clientId, branchId, direction, mode });

  demo('NF-DEMO-01', A('ACME', 'BOM', 'IMPORT', 'AIR'), 'PREPARED', { preparer: 'alice' });
  demo('NF-DEMO-02', A('ACME', 'BOM', 'IMPORT', 'FCL'), 'PREPARED', { preparer: 'sarah' });
  demo('NF-DEMO-03', A('ACME', 'DEL', 'EXPORT', 'AIR'), 'PREPARED', { preparer: 'alice' });
  demo('NF-DEMO-04', A('ACME', 'BOM', 'IMPORT', 'LCL'), 'FILED', { preparer: 'alice', checker: 'raj', filer: 'fiona' });
  demo('NF-DEMO-05', A('CORAL', 'MAA', 'IMPORT', 'AIR'), 'PREPARED', { preparer: 'alice', assigneeId: 'priya' });
  demo('NF-DEMO-06', A('ACME', 'BOM', 'IMPORT', 'AIR'), 'CONFIRMED');
  demo('NF-DEMO-07', A('JUPITER', 'CCU', 'EXPORT', 'LCL'), 'CONFIRMED');
  demo('NF-DEMO-08', A('DELTA', 'DEL', 'IMPORT', 'FCL'), 'FILED', { preparer: 'alice', checker: 'meera', filer: 'omar' });

  const stages: Stage[] = ['CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'PREPARED', 'PREPARED', 'PREPARED', 'CHECKED', 'CHECKED', 'FILED', 'FILED', 'FILED', 'FILED', 'CANCELLED', 'REOPENED'];
  const directions: Direction[] = ['IMPORT', 'EXPORT'];
  const modes: Mode[] = ['AIR', 'FCL', 'LCL'];
  for (let n = 1; n <= jobCount; n++) {
    buildJob(n, A(pick(CLIENTS).id, pick(BRANCHES).id, pick(directions), pick(modes)), pick(stages));
  }

  await prisma.job.createMany({ data: jobs });
  await prisma.jobHistory.createMany({ data: history });

  return { users: USERS.length, jobs: jobs.length, history: history.length, grants: grantRows.length };
}
