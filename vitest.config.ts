import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'vitest/config';

loadEnv();
const testDb = process.env.TEST_DATABASE_URL;
if (!testDb) throw new Error('TEST_DATABASE_URL is not set (copy .env.example to .env)');

export default defineConfig({
  test: {
    // Tests always run against the separate test database, never your demo data.
    env: { DATABASE_URL: testDb, JWT_SECRET: 'test-secret', NODE_ENV: 'test' },
    globalSetup: ['tests/globalSetup.ts'],
    // Integration test files share one database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
