import { execSync } from 'node:child_process';
import { config as loadEnv } from 'dotenv';

/**
 * Runs once before all tests: apply any pending migrations to the separate TEST database.
 * (Each integration test file then clears and reseeds its data via tests/helpers.ts.)
 */
export default function setup() {
  loadEnv();
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
  });
}
