/**
 * The overnight parser, run for real against the test database as the SYSTEM_PARSER identity.
 * Covers brief items #14 (authorised import actions) and #22 (duplicate processing has no duplicate side effects).
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { runParser } from '../../src/services/parserService';
import { prisma, resetDb } from '../helpers';

const sample: unknown[] = JSON.parse(readFileSync('data/parser/sample-shipments.json', 'utf8'));

beforeAll(async () => {
  await resetDb();
});

describe('overnight parser', () => {
  it('processes a mixed batch: bad records are reported, good ones still go through', async () => {
    const run = await runParser(sample, 'test-run-1');
    expect(run.results).toHaveLength(sample.length);
    expect(run.summary).toEqual({ CREATED: 3, UPDATED: 1, UNCHANGED: 1, REJECTED: 3, INVALID: 3 });

    const byRef = Object.fromEntries(run.results.filter((r) => r.externalRef).map((r) => [`${r.externalRef}#${r.index}`, r]));
    expect(byRef['EXT-NF-DEMO-04#4']).toMatchObject({ outcome: 'REJECTED', code: 'FILED_LOCKED' }); // filed jobs are locked
    expect(byRef['EXT-NF-DEMO-07#5']).toMatchObject({ outcome: 'REJECTED', code: 'SCOPE_FIELDS_CHANGED' }); // feed cannot move a job between scopes
    expect(byRef['UNKNOWN-CLIENT-1#8']).toMatchObject({ outcome: 'REJECTED', code: 'UNKNOWN_CLIENT' });

    const created = await prisma.job.findUniqueOrThrow({ where: { externalRef: 'MAEU-24110401' } });
    expect(created).toMatchObject({ createdById: 'parser', stage: 'CONFIRMED', clientId: 'ACME' });
    const createRow = await prisma.jobHistory.findFirstOrThrow({ where: { jobId: created.id, action: 'CREATE' } });
    expect(createRow.actorId).toBe('parser');
    expect(createRow.grantId).not.toBeNull(); // acted under its SYSTEM_PARSER grant

    const filed = await prisma.job.findUniqueOrThrow({ where: { reference: 'NF-DEMO-04' } });
    expect(Number(filed.weightKg)).not.toBe(999);
    expect(filed.consignee).not.toBe('Late correction');
  });

  it('#22 re-running the same file creates nothing new and writes no extra job history', async () => {
    const jobsBefore = await prisma.job.count();
    const historyBefore = await prisma.jobHistory.count();

    const run = await runParser(sample, 'test-run-2');
    expect(run.summary.CREATED).toBe(0);
    expect(run.summary.UPDATED).toBe(0);
    expect(run.summary.UNCHANGED).toBe(5);

    expect(await prisma.job.count()).toBe(jobsBefore);
    expect(await prisma.jobHistory.count()).toBe(historyBefore);
    expect(await prisma.job.count({ where: { externalRef: 'MAEU-24110401' } })).toBe(1);
  });

  it('every record outcome is written to the automation log', async () => {
    const logs = await prisma.automationLog.findMany({ where: { rule: 'PARSER' } });
    const runs = logs.filter((l) => (l.details as { runId?: string })?.runId === 'test-run-2');
    expect(runs).toHaveLength(sample.length);
  });

  it('cannot update a job once a human has prepared it', async () => {
    const job = await prisma.job.findUniqueOrThrow({ where: { externalRef: 'AI-CARGO-77812' } });
    const { performJobAction } = await import('../../src/services/jobService');
    await performJobAction('sarah', job.reference, 'job.prepare');

    const rec = { ...(sample[1] as object), weightKg: 1 };
    const run = await runParser([rec], 'test-run-3');
    expect(run.results[0]).toMatchObject({ outcome: 'REJECTED', code: 'WRONG_STAGE' });
    expect(Number((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).weightKg)).toBe(380);
  });
});
