/**
 * SCALE GENERATOR - separate from the normal dev seed.
 *
 *   npm run seed:scale                          ~500 users, 200,000 jobs
 *   npm run seed:scale -- --jobs 20000          smaller run
 *
 * Writes to its OWN database (SCALE_DATABASE_URL, default: the dev server's "gatekeeper_scale"
 * database), so your demo data and the test database are never touched. It:
 *   1. applies migrations to that database,
 *   2. loads the normal base seed (roles, branches, clients, the 22 named demo users),
 *   3. adds generated users with scoped grants up to --users (default 500),
 *   4. bulk-inserts jobs + a plausible history trail with createMany in batches,
 *   5. runs ANALYZE, prints row counts, and times a few real service calls
 *      (the same code paths the API uses) so you can see query cost at volume.
 *
 * Timings printed are what this machine measured on this run - not a benchmark claim.
 * History is generated to be plausible (actors hold a covering role, the preparer never checks),
 * but it is bulk data: the engine is not re-run for each of the 200k jobs.
 */
import { execSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { config as loadEnv } from 'dotenv';
import type { Direction, Mode, Prisma, Stage } from '@prisma/client';

loadEnv();

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}

const TARGET_USERS = arg('users', 500);
const TARGET_JOBS = arg('jobs', 200_000);
const JOB_BATCH = 1500; // 16 columns x 1500 rows stays well under Postgres' bind-parameter limit
const HISTORY_BATCH = 2000;

const devUrl = process.env.DATABASE_URL;
if (!devUrl) throw new Error('DATABASE_URL is not set (copy .env.example to .env)');
const scaleUrl = process.env.SCALE_DATABASE_URL ?? devUrl.replace(/\/([^/?]+)(\?|$)/, '/gatekeeper_scale$2');
if (scaleUrl === devUrl) throw new Error('Refusing to run: the scale database must be different from DATABASE_URL.');
// Must be set before src/db is loaded, so the services below talk to the scale database.
process.env.DATABASE_URL = scaleUrl;

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  console.log(`  ${label.padEnd(58)} ${(performance.now() - t0).toFixed(0).padStart(6)} ms`);
  return out;
}

async function main() {
  console.log(`Scale database: ${scaleUrl.replace(/\/\/[^@]*@/, '//***@')}`);
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: { ...process.env, DATABASE_URL: scaleUrl } });

  const { prisma } = await import('../src/db');
  const { seedDatabase, BRANCHES, CLIENTS, DEMO_PASSWORD, emailFor } = await import('../src/seed/seed');
  const { listJobs } = await import('../src/services/jobService');
  const { waitingForMe } = await import('../src/services/queueService');
  const { getJobHistory, whoCouldAct } = await import('../src/services/historyService');
  const bcrypt = (await import('bcryptjs')).default;

  const rand = mulberry32(7);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const started = performance.now();

  // ---------------------------------------------------------------- base seed (also truncates)
  await timed('base seed (roles, branches, clients, 22 demo users)', () => seedDatabase(prisma, { jobCount: 0 }));

  // ---------------------------------------------------------------- generated users + grants
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const existing = await prisma.user.count();
  const toMake = Math.max(0, TARGET_USERS - existing);
  const users: Prisma.UserCreateManyInput[] = [];
  const grants: Prisma.AccessGrantCreateManyInput[] = [];
  const pools: Record<'MAKER' | 'CHECKER' | 'FILER', { userId: string; grantId: string }[]> = { MAKER: [], CHECKER: [], FILER: [] };
  const epoch = new Date('2026-01-01T00:00:00Z');

  for (let i = 1; i <= toMake; i++) {
    const id = `s${String(i).padStart(4, '0')}`;
    const r = rand();
    // Mix: 34% makers, 34% checkers, 13% filers, 8% client viewers, 7% internal viewers, 4% ops admins.
    const role = r < 0.34 ? 'MAKER' : r < 0.68 ? 'CHECKER' : r < 0.81 ? 'FILER' : r < 0.89 ? 'CLIENT_VIEWER' : r < 0.96 ? 'VIEWER' : 'OPS_ADMIN';
    const isClient = role === 'CLIENT_VIEWER';
    const clientId = isClient ? pick(CLIENTS).id : null;
    users.push({ id, name: `Scale User ${i}`, email: emailFor(id), type: isClient ? 'CLIENT' : 'STAFF', clientId, passwordHash });

    // Every 10th maker/checker/filer is unscoped; those form the pools used to author history.
    const global = (role === 'MAKER' || role === 'CHECKER' || role === 'FILER') && i % 10 === 0;
    const scope = isClient
      ? { clientId }
      : global || role === 'VIEWER'
        ? {}
        : rand() < 0.5
          ? { branchId: pick(BRANCHES).id }
          : { clientId: pick(CLIENTS).id };
    const grantId = `sgrant_${id}`;
    grants.push({ id: grantId, userId: id, roleId: role, ...scope, validFrom: epoch, createdAt: epoch, reason: 'Scale data', grantedById: 'anita' });
    if (global) pools[role as keyof typeof pools].push({ userId: id, grantId });
  }
  // Make sure each pool is non-empty even for tiny --users values.
  const demoGrant = async (userId: string, roleId: string) => (await prisma.accessGrant.findFirstOrThrow({ where: { userId, roleId, revokedAt: null } })).id;
  pools.MAKER.push({ userId: 'alice', grantId: await demoGrant('alice', 'MAKER') }, { userId: 'sarah', grantId: await demoGrant('sarah', 'MAKER') });
  if (pools.CHECKER.length === 0) throw new Error('Too few users to form an unscoped checker pool; use --users 100 or more.');
  pools.FILER.push({ userId: 'fiona', grantId: await demoGrant('fiona', 'FILER') });

  await timed(`insert ${users.length} generated users`, () => prisma.user.createMany({ data: users }));
  await timed(`insert ${grants.length} grants`, () => prisma.accessGrant.createMany({ data: grants }));

  // ---------------------------------------------------------------- jobs + history
  const stages: Stage[] = ['CONFIRMED', 'CONFIRMED', 'PREPARED', 'PREPARED', 'CHECKED', 'FILED', 'FILED', 'FILED', 'FILED', 'FILED', 'CANCELLED', 'REOPENED'];
  const directions: Direction[] = ['IMPORT', 'EXPORT'];
  const modes: Mode[] = ['AIR', 'FCL', 'LCL'];
  const consignees = ['Hindustan Traders', 'Sagar Imports', 'Orion Logistics', 'Western Distributors', 'Kaveri Exports', 'Nova Retail'];
  const parserGrant = await demoGrant('parser', 'SYSTEM_PARSER');
  const now = Date.now();
  let historyCount = 0;

  const t0 = performance.now();
  for (let start = 1; start <= TARGET_JOBS; start += JOB_BATCH) {
    const jobs: Prisma.JobCreateManyInput[] = [];
    const history: Prisma.JobHistoryCreateManyInput[] = [];
    for (let n = start; n < Math.min(start + JOB_BATCH, TARGET_JOBS + 1); n++) {
      const id = `sjob_${String(n).padStart(7, '0')}`;
      const reference = `NF-S${String(n).padStart(7, '0')}`;
      const target = pick(stages);
      let t = new Date(now - Math.floor(rand() * 365) * DAY - Math.floor(rand() * 24) * HOUR);
      const step = () => (t = new Date(t.getTime() + (1 + Math.floor(rand() * 30)) * HOUR));
      const createdAt = t;
      history.push({ jobId: id, actorId: 'parser', via: 'DIRECT', action: 'CREATE', fromStage: null, toStage: 'CONFIRMED', grantId: parserGrant, createdAt });

      const path: Stage[] = target === 'CANCELLED' || target === 'REOPENED' ? ['PREPARED', 'CHECKED', 'FILED'] : (['PREPARED', 'CHECKED', 'FILED'] as Stage[]).slice(0, ['CONFIRMED', 'PREPARED', 'CHECKED', 'FILED'].indexOf(target));
      let from: Stage = 'CONFIRMED';
      const maker = pick(pools.MAKER);
      for (const s of path) {
        const who = s === 'PREPARED' ? maker : s === 'CHECKED' ? pick(pools.CHECKER.filter((c) => c.userId !== maker.userId)) : pick(pools.FILER);
        history.push({ jobId: id, actorId: who.userId, via: 'DIRECT', action: s === 'PREPARED' ? 'PREPARE' : s === 'CHECKED' ? 'CHECK' : 'FILE', fromStage: from, toStage: s, grantId: who.grantId || null, createdAt: step() });
        from = s;
      }
      if (target === 'CANCELLED' || target === 'REOPENED') {
        history.push({ jobId: id, actorId: 'omar', via: 'DIRECT', action: 'CANCEL', fromStage: 'FILED', toStage: 'CANCELLED', reason: 'Duplicate filing', createdAt: step() });
        from = 'CANCELLED';
        if (target === 'REOPENED') {
          history.push({ jobId: id, actorId: 'omar', via: 'DIRECT', action: 'REOPEN', fromStage: 'CANCELLED', toStage: 'REOPENED', reason: 'Refile with corrections', createdAt: step() });
          from = 'REOPENED';
        }
      }
      jobs.push({
        id, reference, externalRef: `EXT-${reference}`,
        clientId: pick(CLIENTS).id, branchId: pick(BRANCHES).id, direction: pick(directions), mode: pick(modes),
        stage: from, stageEnteredAt: t, consignee: pick(consignees),
        weightKg: Math.round(rand() * 200_000) / 10, valueInr: Math.round(rand() * 5_000_000),
        createdById: 'parser', createdAt,
      });
    }
    await prisma.job.createMany({ data: jobs });
    for (let i = 0; i < history.length; i += HISTORY_BATCH) await prisma.jobHistory.createMany({ data: history.slice(i, i + HISTORY_BATCH) });
    historyCount += history.length;
    const done = Math.min(start + JOB_BATCH - 1, TARGET_JOBS);
    if (done % 15_000 < JOB_BATCH || done === TARGET_JOBS) {
      console.log(`  ... ${done.toLocaleString()} jobs, ${historyCount.toLocaleString()} history rows (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    }
  }
  await prisma.$executeRawUnsafe('ANALYZE');

  // ---------------------------------------------------------------- verify
  const [u, g, j, h] = await Promise.all([prisma.user.count(), prisma.accessGrant.count(), prisma.job.count(), prisma.jobHistory.count()]);
  const byStage = await prisma.job.groupBy({ by: ['stage'], _count: { _all: true }, orderBy: { stage: 'asc' } });
  console.log(`\nRows: ${u} users, ${g} grants, ${j.toLocaleString()} jobs, ${h.toLocaleString()} history rows`);
  console.log('Jobs by stage:', Object.fromEntries(byStage.map((s) => [s.stage, s._count._all])));
  console.log(`Total generation time: ${((performance.now() - started) / 1000).toFixed(1)} s\n`);

  console.log('Sample service calls at this volume (single run each, this machine):');
  await timed('listJobs(raj) - scoped checker, first page of 50', () => listJobs('raj', { limit: 50 }));
  await timed('listJobs(ian) - global viewer, first page of 50', () => listJobs('ian', { limit: 50 }));
  await timed('listJobs(tom) - client user, filter stage=FILED', () => listJobs('tom', { limit: 50, stage: 'FILED' }));
  await timed('waitingForMe(karan) - 3 branch scopes', () => waitingForMe('karan', { limit: 50 }));
  await timed('waitingForMe(fiona) - global filer', () => waitingForMe('fiona', { limit: 50 }));
  const sample = await prisma.job.findFirstOrThrow({ where: { stage: 'PREPARED' }, orderBy: { id: 'desc' } });
  await timed(`getJobHistory(anita, ${sample.reference})`, () => getJobHistory('anita', sample.reference));
  await timed(`whoCouldAct(anita, ${sample.reference}) - engine over ${u} users`, () => whoCouldAct('anita', sample.reference, new Date()));

  console.log('\nInspect it yourself, e.g.:');
  console.log(`  docker exec -it gatekeeper-postgres psql -U gatekeeper -d gatekeeper_scale -c 'SELECT stage, count(*) FROM "Job" GROUP BY 1'`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
