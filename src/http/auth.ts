/**
 * AUTHENTICATION ("who are you?") - separate from authorization ("what may you do?").
 * The JWT carries ONLY the user id. Roles/grants are NOT put in the token: they are read
 * from the database on every request, so a revoked grant or deactivated account takes
 * effect immediately instead of when the token expires.
 */
import bcrypt from 'bcryptjs';
import { Router, type RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../db';
import { AppError } from './errors';

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
  }
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'] });
}

const unauthorized = () => new AppError(401, 'UNAUTHENTICATED', 'Missing, invalid or expired token.');

/** Requires a valid Bearer token for an existing, ACTIVE user. Sets req.userId. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorized());
  let sub: string;
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (typeof payload === 'string' || typeof payload.sub !== 'string') return next(unauthorized());
    sub = payload.sub;
  } catch {
    return next(unauthorized());
  }
  const user = await prisma.user.findUnique({ where: { id: sub }, select: { id: true, status: true } });
  if (!user || user.status !== 'ACTIVE') return next(unauthorized());
  req.userId = user.id; // the ONLY trusted source of "who is acting"
  next();
};

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  // Same message for every failure so the endpoint does not reveal which emails exist.
  const ok = user && user.passwordHash && user.status === 'ACTIVE' && (await bcrypt.compare(password, user.passwordHash));
  if (!ok || !user) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  res.json({ token: signToken(user.id), user: { id: user.id, name: user.name, type: user.type } });
});
