/**
 * Overnight parser CLI.
 *   npm run parser:run                                   (uses data/parser/sample-shipments.json)
 *   npm run parser:run -- data/parser/sample-shipments.csv
 * Runs as the SYSTEM_PARSER identity through the AuthorizationEngine. Safe to re-run:
 * records are matched by externalRef, so a second run reports UNCHANGED instead of duplicating.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/db';
import { runParser } from '../src/services/parserService';

/** Minimal CSV reader: header row + comma-separated values (no quoted commas - fine for the sample feed). */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

async function main() {
  const file = process.argv[2] ?? 'data/parser/sample-shipments.json';
  const text = readFileSync(file, 'utf8');
  const records: unknown = path.extname(file).toLowerCase() === '.csv' ? parseCsv(text) : JSON.parse(text);
  if (!Array.isArray(records)) throw new Error('Input must be a JSON array or a CSV file.');

  const run = await runParser(records, `run_${path.basename(file)}_${new Date().toISOString()}`);
  console.log(`Parser run ${run.runId} - ${records.length} record(s) from ${file}\n`);
  console.table(
    run.results.map((r) => ({
      '#': r.index,
      externalRef: r.externalRef ?? '-',
      outcome: r.outcome,
      job: r.jobReference ?? '',
      code: r.code ?? '',
      message: (r.message ?? '').slice(0, 70),
    })),
  );
  console.log('Summary:', run.summary);
  console.log('Every outcome is in the AutomationLog (rule = PARSER): GET /audit/automation');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
