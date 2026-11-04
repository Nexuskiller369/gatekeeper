/**
 * Shared helpers for integration tests. Everything runs against the real engine, real
 * services and a real Postgres test database - nothing in the authorization path is mocked.
 */
import request from 'supertest';
import type { Direction, Mode } from '@prisma/client';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/http/auth';
import { seedDatabase } from '../src/seed/seed';
import { createJob, performJobAction } from '../src/services/jobService';

export const app = createApp();
export { prisma };

/** Wipe the test database and load the standard seed (small job count for speed). */
export async function resetDb() {
  await seedDatabase(prisma, { jobCount: 40 });
}

/** A Bearer header for a seeded user (skips bcrypt; /auth/login itself is tested separately). */
export const as = (userId: string) => ({ Authorization: `Bearer ${signToken(userId)}` });

/** Supertest shorthands that always send the caller's token. */
export const api = {
  get: (userId: string, url: string) => request(app).get(url).set(as(userId)),
  post: (userId: string, url: string, body: object = {}) => request(app).post(url).set(as(userId)).send(body),
  patch: (userId: string, url: string, body: object = {}) => request(app).patch(url).set(as(userId)).send(body),
};

let counter = 0;

/**
 * Creates a job the way production does (as the parser) and optionally moves it to PREPARED
 * as `preparer`. Goes through the real services, so the engine checks every step.
 */
export async function makeJob(
  attrs: { clientId: string; branchId: string; direction: Direction; mode?: Mode },
  opts: { preparer?: string } = {},
) {
  counter += 1;
  const reference = `NF-T-${Date.now().toString(36)}-${counter}`;
  const { job } = await createJob('parser', {
    reference,
    externalRef: `EXT-${reference}`,
    clientId: attrs.clientId,
    branchId: attrs.branchId,
    direction: attrs.direction,
    mode: attrs.mode ?? 'AIR',
    consignee: 'Test Consignee',
    weightKg: 100,
    valueInr: 50000,
  });
  if (opts.preparer) await performJobAction(opts.preparer, reference, 'job.prepare');
  return prisma.job.findUniqueOrThrow({ where: { reference } });
}
