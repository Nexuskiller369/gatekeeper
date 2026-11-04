/**
 * Print every user's access in plain English (the "access review" a manager would read).
 *   npm run access:describe            -> everyone
 *   npm run access:describe -- raj     -> one user
 * Text comes from the same describeGrant()/describeDelegation() used by GET /auth/me and GET /users.
 */
import { prisma } from '../src/db';
import { describeUserAccess } from '../src/services/accessService';

async function main() {
  const only = process.argv[2];
  const ids = only ? [only] : (await prisma.user.findMany({ orderBy: [{ type: 'asc' }, { id: 'asc' }], select: { id: true } })).map((u) => u.id);

  for (const id of ids) {
    const u = await describeUserAccess(id);
    const flags = [u.type, u.status !== 'ACTIVE' ? u.status : null, u.absentNow ? 'ABSENT NOW' : null, u.clientId ? `client ${u.clientId}` : null].filter(Boolean);
    console.log(`\n${u.name} <${u.email}>  [${flags.join(', ')}]`);
    if (u.access.length === 0 && u.delegations.length === 0) console.log('  - no access');
    for (const line of u.access) console.log(`  - ${line}`);
    for (const line of u.delegations) console.log(`  - ${line}`);
    for (const a of u.absences) console.log(`  ! absent ${a.startsAt.toISOString().slice(0, 10)} to ${a.endsAt.toISOString().slice(0, 10)}: ${a.reason}`);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
