import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { hashPassword, verifyPassword, newRefreshToken, requireAuth, env } from '../../lib/auth.js';
import { resolveCaps } from '../../lib/rbac.js';
import { createHash } from 'crypto';

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post('/register', {
    schema: {
      body: z.object({
        workspaceName: z.string().min(2),
        name: z.string().min(2),
        email: z.string().email(),
        password: z.string().min(8),
        phone: z.string().optional(),
      }),
    },
  }, async (req) => {
    const b = req.body as { workspaceName: string; name: string; email: string; password: string; phone?: string };
    const passwordHash = await hashPassword(b.password);
    const workspace = await prisma.workspace.create({ data: { name: b.workspaceName } });
    const user = await prisma.user.create({
      data: {
        workspaceId: workspace.id,
        email: b.email, name: b.name, phone: b.phone,
        passwordHash, role: 'owner',
      },
    });
    return { ok: true, workspace: { id: workspace.id, name: workspace.name }, user: { id: user.id, email: user.email } };
  });

  app.post('/login', {
    schema: { body: z.object({ email: z.string().email(), password: z.string() }) },
  }, async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string };
    const user = await prisma.user.findUnique({ where: { email }, include: { customRole: true } });
    if (!user || user.status !== 'active') return reply.code(401).send({ message: 'Invalid credentials' });
    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) return reply.code(401).send({ message: 'Invalid credentials' });

    const access = app.jwt.sign({ sub: user.id, ws: user.workspaceId, role: user.role });
    const rt = newRefreshToken();
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: rt.hash,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
        userAgent: req.headers['user-agent'] ?? null,
        ipAddress: req.ip,
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    reply.setCookie('rt', rt.token, {
      httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax',
      path: '/api/auth', maxAge: 60 * 60 * 24 * 30,
    });

    return {
      accessToken: access,
      user: {
        id: user.id, email: user.email, name: user.name, role: user.role,
        branchId: user.branchId, workspaceId: user.workspaceId,
        caps: Array.from(resolveCaps(user)),
      },
    };
  });

  app.post('/refresh', async (req, reply) => {
    const token = req.cookies.rt;
    if (!token) return reply.code(401).send({ message: 'No refresh token' });
    const hash = createHash('sha256').update(token).digest('hex');
    const rt = await prisma.refreshToken.findUnique({ where: { tokenHash: hash }, include: { user: true } });
    if (!rt || rt.revokedAt || rt.expiresAt < new Date()) {
      return reply.code(401).send({ message: 'Invalid refresh token' });
    }
    const access = app.jwt.sign({ sub: rt.user.id, ws: rt.user.workspaceId, role: rt.user.role });
    return { accessToken: access };
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies.rt;
    if (token) {
      const hash = createHash('sha256').update(token).digest('hex');
      await prisma.refreshToken.updateMany({ where: { tokenHash: hash }, data: { revokedAt: new Date() } });
    }
    reply.clearCookie('rt', { path: '/api/auth' });
    return { ok: true };
  });

  app.get('/me', async (req, reply) => {
    const me = await requireAuth(req, reply);
    return me;
  });
}
