import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireCap, hashPassword } from '../../lib/auth.js';
import { resolveCaps } from '../../lib/rbac.js';

export async function registerUserRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [requireCap('users.read')] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    const users = await prisma.user.findMany({
      where: { workspaceId: me.workspaceId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        branchId: true,
        status: true,
        lastLoginAt: true,
        createdAt: true,
        permissionsAdd: true,
        permissionsRemove: true,
        customRoleId: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return users;
  });

  app.post(
    '/invite',
    {
      preHandler: [requireCap('users.invite')],
      schema: {
        body: z.object({
          name: z.string().min(2),
          email: z.string().email(),
          phone: z.string().optional(),
          role: z.string(),
          branchId: z.string().optional(),
          tempPassword: z.string().min(8),
        }),
      },
    },
    async (req) => {
      const me = (req as unknown as { me: { workspaceId: string } }).me;
      const b = req.body as {
        name: string;
        email: string;
        phone?: string;
        role: string;
        branchId?: string;
        tempPassword: string;
      };
      const passwordHash = await hashPassword(b.tempPassword);
      const user = await prisma.user.create({
        data: {
          workspaceId: me.workspaceId,
          name: b.name,
          email: b.email,
          phone: b.phone,
          role: b.role as never,
          branchId: b.branchId,
          passwordHash,
        },
        select: { id: true, email: true, name: true, role: true },
      });
      // TODO: enqueue invite email/SMS via worker
      return user;
    },
  );

  app.patch(
    '/:id/grant',
    {
      preHandler: [requireCap('users.grant')],
      schema: {
        body: z.object({
          permissionsAdd: z.array(z.string()).optional(),
          permissionsRemove: z.array(z.string()).optional(),
        }),
      },
    },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string } }).me;
      const { id } = req.params as { id: string };
      const b = req.body as { permissionsAdd?: string[]; permissionsRemove?: string[] };
      const target = await prisma.user.findFirst({ where: { id, workspaceId: me.workspaceId } });
      if (!target) return reply.code(404).send({ message: 'User not found' });
      const u = await prisma.user.update({
        where: { id },
        data: {
          ...(b.permissionsAdd ? { permissionsAdd: b.permissionsAdd } : {}),
          ...(b.permissionsRemove ? { permissionsRemove: b.permissionsRemove } : {}),
        },
      });
      return { ok: true, caps: Array.from(resolveCaps(u)) };
    },
  );

  app.patch(
    '/:id/role',
    {
      preHandler: [requireCap('roles.assign')],
      schema: { body: z.object({ role: z.string() }) },
    },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string } }).me;
      const { id } = req.params as { id: string };
      const { role } = req.body as { role: string };
      const { count } = await prisma.user.updateMany({
        where: { id, workspaceId: me.workspaceId },
        data: { role: role as never },
      });
      if (count === 0) return reply.code(404).send({ message: 'User not found' });
      return { ok: true };
    },
  );

  app.patch(
    '/:id/deactivate',
    { preHandler: [requireCap('users.deactivate')] },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string } }).me;
      const { id } = req.params as { id: string };
      const { count } = await prisma.user.updateMany({
        where: { id, workspaceId: me.workspaceId },
        data: { status: 'inactive' },
      });
      if (count === 0) return reply.code(404).send({ message: 'User not found' });
      return { ok: true };
    },
  );
}
