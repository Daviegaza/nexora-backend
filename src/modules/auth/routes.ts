import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { hashPassword, verifyPassword, newRefreshToken, requireAuth, env } from '../../lib/auth.js';
import { resolveCaps } from '../../lib/rbac.js';
import { writeAudit } from '../../lib/audit.js';
import { createHash, randomUUID } from 'crypto';

const REFRESH_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const REFRESH_COOKIE = 'rt';
const REFRESH_COOKIE_PATH = '/api/auth';

const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$WRppLzo6uOa4uAeIKGnKuw$g4KXWnBu5+jSJIx0Fo2gaqcjNZZG3o3MJUyE7GtxzoI';

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

async function issueRefreshToken(
  userId: string,
  familyId: string | null,
  req: { headers: Record<string, unknown>; ip: string },
) {
  const rt = newRefreshToken();
  const record = await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: rt.hash,
      familyId: familyId ?? randomUUID(),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      ipAddress: req.ip,
    },
  });
  return { token: rt.token, record };
}

function setRefreshCookie(
  reply: { setCookie: (name: string, value: string, opts: Record<string, unknown>) => void },
  token: string,
) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TTL_MS / 1000,
  });
}

export async function registerAuthRoutes(app: FastifyInstance) {
  // Per-route rate limits (mounted only if fastify-rate-limit is registered globally)
  const loginLimit = { max: 5, timeWindow: '1 minute' } as const;
  const registerLimit = { max: 3, timeWindow: '1 hour' } as const;
  const refreshLimit = { max: 60, timeWindow: '1 minute' } as const;

  app.post(
    '/register',
    {
      config: { rateLimit: registerLimit },
      schema: {
        body: z.object({
          workspaceName: z.string().min(2),
          name: z.string().min(2),
          email: z.string().email(),
          password: z.string().min(8),
          phone: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const b = req.body as {
        workspaceName: string;
        name: string;
        email: string;
        password: string;
        phone?: string;
      };
      const passwordHash = await hashPassword(b.password);
      const workspace = await prisma.workspace.create({ data: { name: b.workspaceName } });
      const user = await prisma.user.create({
        data: {
          workspaceId: workspace.id,
          email: b.email.toLowerCase(),
          name: b.name,
          phone: b.phone,
          passwordHash,
          role: 'owner',
        },
      });
      await writeAudit(prisma, {
        workspaceId: workspace.id,
        actorId: user.id,
        action: 'workspace.create',
        resource: 'workspace',
        resourceId: workspace.id,
        ip: req.ip,
        meta: { email: user.email },
      });
      return {
        ok: true,
        workspace: { id: workspace.id, name: workspace.name },
        user: { id: user.id, email: user.email },
      };
    },
  );

  app.post(
    '/login',
    {
      config: { rateLimit: loginLimit },
      schema: { body: z.object({ email: z.string().email(), password: z.string() }) },
    },
    async (req, reply) => {
      const { email, password } = req.body as { email: string; password: string };
      const normalizedEmail = email.toLowerCase();
      // Timing-safe: always run argon2.verify to equalize response time
      const user = await prisma.user.findFirst({
        where: { email: normalizedEmail, status: 'active' },
        include: { customRole: true },
      });
      const hash = user?.passwordHash ?? DUMMY_HASH;
      const ok = await verifyPassword(hash, password);
      if (!user || !ok) return reply.code(401).send({ message: 'Invalid credentials' });

      const access = app.jwt.sign({ sub: user.id, ws: user.workspaceId, role: user.role });
      const { token } = await issueRefreshToken(user.id, null, req);
      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await writeAudit(prisma, {
        workspaceId: user.workspaceId,
        actorId: user.id,
        action: 'user.login',
        resource: 'user',
        resourceId: user.id,
        ip: req.ip,
        meta: { userAgent: req.headers['user-agent'] ?? null },
      });
      setRefreshCookie(reply, token);

      return {
        accessToken: access,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          branchId: user.branchId,
          workspaceId: user.workspaceId,
          caps: Array.from(resolveCaps(user)),
        },
      };
    },
  );

  // Refresh with rotation + reuse detection.
  // If a revoked token is presented, revoke the entire family (suspected theft).
  app.post('/refresh', { config: { rateLimit: refreshLimit } }, async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) return reply.code(401).send({ message: 'No refresh token' });
    const tokenHash = hashToken(token);
    const rt = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!rt) return reply.code(401).send({ message: 'Invalid refresh token' });

    if (rt.revokedAt) {
      // Reuse — nuke the family.
      await prisma.refreshToken.updateMany({
        where: { familyId: rt.familyId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'reuse_detected' },
      });
      req.log.warn({ userId: rt.userId, familyId: rt.familyId }, 'refresh reuse detected');
      reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
      return reply.code(401).send({ message: 'Session revoked' });
    }
    if (rt.expiresAt < new Date()) {
      return reply.code(401).send({ message: 'Refresh token expired' });
    }
    if (rt.user.status !== 'active') {
      return reply.code(401).send({ message: 'Inactive user' });
    }

    // Rotate.
    const issued = await issueRefreshToken(rt.userId, rt.familyId, req);
    await prisma.refreshToken.update({
      where: { id: rt.id },
      data: { revokedAt: new Date(), replacedById: issued.record.id, revokedReason: 'rotated' },
    });
    const access = app.jwt.sign({
      sub: rt.user.id,
      ws: rt.user.workspaceId,
      role: rt.user.role,
    });
    setRefreshCookie(reply, issued.token);
    return { accessToken: access };
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) {
      const rt = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
      if (rt) {
        // Revoke the whole family on logout.
        await prisma.refreshToken.updateMany({
          where: { familyId: rt.familyId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'logout' },
        });
      }
    }
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    return { ok: true };
  });

  app.get('/me', async (req, reply) => {
    const me = await requireAuth(req, reply);
    return me;
  });
}
