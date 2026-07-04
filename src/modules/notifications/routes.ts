import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireCap } from '../../lib/auth.js';

export async function registerNotificationRoutes(app: FastifyInstance) {
  // GET /  — list current user's notifications (own + workspace-wide unassigned)
  app.get('/', { preHandler: [requireAuth] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
    const q = req.query as { unreadOnly?: string; limit?: string };
    return prisma.notification.findMany({
      where: {
        workspaceId: me.workspaceId,
        OR: [{ userId: me.id }, { userId: null }],
        ...(q.unreadOnly === 'true' ? { read: false } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(q.limit ?? 50), 200),
    });
  });

  app.get('/unread-count', { preHandler: [requireAuth] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
    const count = await prisma.notification.count({
      where: {
        workspaceId: me.workspaceId,
        OR: [{ userId: me.id }, { userId: null }],
        read: false,
      },
    });
    return { count };
  });

  app.post('/:id/read', { preHandler: [requireAuth] }, async (req, reply) => {
    const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
    const { id } = req.params as { id: string };
    const { count } = await prisma.notification.updateMany({
      where: {
        id,
        workspaceId: me.workspaceId,
        OR: [{ userId: me.id }, { userId: null }],
      },
      data: { read: true },
    });
    if (count === 0) return reply.code(404).send({ message: 'Notification not found' });
    return { ok: true };
  });

  app.post('/read-all', { preHandler: [requireAuth] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
    const { count } = await prisma.notification.updateMany({
      where: {
        workspaceId: me.workspaceId,
        OR: [{ userId: me.id }, { userId: null }],
        read: false,
      },
      data: { read: true },
    });
    return { ok: true, marked: count };
  });

  // Server-side create — usually called by workers, not clients.
  // Gated on `notifications.send` so only ops roles can broadcast.
  app.post(
    '/',
    {
      preHandler: [requireCap('notifications.send')],
      schema: {
        body: z.object({
          userId: z.string().optional(),
          title: z.string().min(1),
          message: z.string().min(1),
          type: z.enum(['info', 'success', 'warning', 'error']).default('info'),
          href: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const me = (req as unknown as { me: { workspaceId: string } }).me;
      const b = req.body as {
        userId?: string;
        title: string;
        message: string;
        type: string;
        href?: string;
      };
      return prisma.notification.create({
        data: {
          workspaceId: me.workspaceId,
          userId: b.userId,
          title: b.title,
          message: b.message,
          type: b.type,
          href: b.href,
        },
      });
    },
  );
}
