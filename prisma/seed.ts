import { PrismaClient } from '@prisma/client';
import { DEMO_PASSWORD, seedDatabase } from '../src/seed/seed';

const prisma = new PrismaClient();

seedDatabase(prisma)
  .then((r) => {
    console.log(`Seeded ${r.users} users, ${r.grants} grants, ${r.jobs} jobs, ${r.history} history rows.`);
    console.log(`All human users log in with password: ${DEMO_PASSWORD}  (e.g. sarah@nfpl.test)`);
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
