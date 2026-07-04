import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireCap } from '../../lib/auth.js';
import { writeAudit } from '../../lib/audit.js';

const BranchInput = z.object({
  name: z.string().min(1),
  county: z.string().min(1),
  location: z.string().optional(),
  phone: z.string().optional(),
  managerId: z.string().optional(),
  status: z.enum(['active', 'inactive']).default('active'),
});

export async function registerBranchRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [requireCap('nav:/branches')] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    return prisma.branch.findMany({
      where: { workspaceId: me.workspaceId },
      orderBy: { name: 'asc' },
    });
  });

  app.post(
    '/',
    { preHandler: [requireCap('branches.write')], schema: { body: BranchInput } },
    async (req) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const b = req.body as z.infer<typeof BranchInput>;
      const branch = await prisma.branch.create({
        data: { workspaceId: me.workspaceId, ...b },
      });
      await writeAudit(prisma, {
        workspaceId: me.workspaceId,
        actorId: me.id,
        action: 'branch.create',
        resource: 'branch',
        resourceId: branch.id,
        ip: req.ip,
      });
      return branch;
    },
  );

  app.put(
    '/:id',
    {
      preHandler: [requireCap('branches.write')],
      schema: { body: BranchInput.partial() },
    },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const { id } = req.params as { id: string };
      const { count } = await prisma.branch.updateMany({
        where: { id, workspaceId: me.workspaceId },
        data: req.body as Partial<z.infer<typeof BranchInput>>,
      });
      if (count === 0) return reply.code(404).send({ message: 'Branch not found' });
      await writeAudit(prisma, {
        workspaceId: me.workspaceId,
        actorId: me.id,
        action: 'branch.update',
        resource: 'branch',
        resourceId: id,
        ip: req.ip,
      });
      return prisma.branch.findUnique({ where: { id } });
    },
  );
}
