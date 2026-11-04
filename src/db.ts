import { PrismaClient } from '@prisma/client';

/** One shared Prisma client (connection pool) for the whole process. */
export const prisma = new PrismaClient();

export type Db = PrismaClient;
