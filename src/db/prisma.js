import { PrismaClient } from '@prisma/client';

// Single PrismaClient for the whole process. globalThis guard keeps nodemon
// restarts from stacking connections. Password is omitted globally — handlers
// that need the hash (login, changePassword) opt back in with
// omit: { password: false }.
const globalForPrisma = globalThis;

const prisma =
  globalForPrisma.__alertupPrisma ??
  new PrismaClient({
    omit: {
      user: { password: true },
    },
  });

if (!globalForPrisma.__alertupPrisma) {
  globalForPrisma.__alertupPrisma = prisma;
}

export default prisma;
