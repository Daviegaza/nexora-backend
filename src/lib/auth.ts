import argon2 from 'argon2';
import { randomBytes, createHash } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from './prisma.js';
import { env } from './env.js';
import { resolveCaps } from './rbac.js';

export async function hashPassword(plain: string) {
  // OWASP 2024 minimum: argon2id, memoryCost=19MiB, timeCost=2, parallelism=1
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}
export async function verifyPassword(hash: string, plain: string) {
  return argon2.verify(hash, plain);
}

export function newRefreshToken() {
  const token = randomBytes(48).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  return { token, hash };
}

export interface SessionUser {
  id: string;
  workspaceId: string;
  email: string;
  name: string;
  role: string;
  branchId?: string | null;
  caps: string[];
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<SessionUser> {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ message: 'Unauthorized' });
    throw new Error('Unauthorized');
  }
  const payload = (req as unknown as { user: { sub: string } }).user;
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { customRole: true },
  });
  if (!user || user.status !== 'active') {
    reply.code(401).send({ message: 'Inactive user' });
    throw new Error('Inactive');
  }
  const caps = resolveCaps(user);
  return {
    id: user.id,
    workspaceId: user.workspaceId,
    email: user.email,
    name: user.name,
    role: user.role,
    branchId: user.branchId,
    caps: Array.from(caps),
  };
}

export function requireCap(cap: string) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const me = await requireAuth(req, reply);
    if (!me.caps.includes(cap)) {
      reply.code(403).send({ message: `Missing capability: ${cap}` });
      throw new Error('Forbidden');
    }
    (req as unknown as { me: SessionUser }).me = me;
  };
}

export { env };
