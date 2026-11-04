import express from 'express';
import { authRouter, requireAuth } from './http/auth';
import { errorHandler } from './http/errors';
import { apiRouter } from './http/routes';
import { landingPage } from './http/landing';
import { prisma } from './db';

/** Builds the Express app (no listen() here, so tests can drive it with Supertest). */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/', (_req, res) => {
    res.type('html').send(landingPage);
  });

  app.get('/health', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok' });
  });

  app.use('/auth', authRouter); // /auth/login is public
  app.use(requireAuth); // everything below needs a valid token
  app.use(apiRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } });
  });
  app.use(errorHandler);
  return app;
}
