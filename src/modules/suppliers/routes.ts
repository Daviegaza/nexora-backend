import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireCap } from '../../lib/auth.js';
import { writeAudit } from '../../lib/audit.js';

const SupplierInput = z.object({
  name: z.string().min(1),
  contact: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  county: z.string().optional(),
  category: z.string().optional(),
  paymentTerms: z.string().optional(),
  leadTime: z.string().optional(),
});

export async function registerSupplierRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [requireCap('suppliers.read')] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    return prisma.supplier.findMany({
      where: { workspaceId: me.workspaceId, status: 'active' },
      orderBy: { name: 'asc' },
    });
  });

  app.post(
    '/',
    { preHandler: [requireCap('suppliers.write')], schema: { body: SupplierInput } },
    async (req) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const b = req.body as z.infer<typeof SupplierInput>;
      const s = await prisma.supplier.create({
        data: { workspaceId: me.workspaceId, ...b },
      });
      await writeAudit(prisma, {
        workspaceId: me.workspaceId,
        actorId: me.id,
        action: 'supplier.create',
        resource: 'supplier',
        resourceId: s.id,
        ip: req.ip,
      });
      return s;
    },
  );

  app.put(
    '/:id',
    {
      preHandler: [requireCap('suppliers.write')],
      schema: { body: SupplierInput.partial() },
    },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const { id } = req.params as { id: string };
      const { count } = await prisma.supplier.updateMany({
        where: { id, workspaceId: me.workspaceId },
        data: req.body as Partial<z.infer<typeof SupplierInput>>,
      });
      if (count === 0) return reply.code(404).send({ message: 'Supplier not found' });
      await writeAudit(prisma, {
        workspaceId: me.workspaceId,
        actorId: me.id,
        action: 'supplier.update',
        resource: 'supplier',
        resourceId: id,
        ip: req.ip,
      });
      return prisma.supplier.findUnique({ where: { id } });
    },
  );

  app.delete('/:id', { preHandler: [requireCap('suppliers.write')] }, async (req, reply) => {
    const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
    const { id } = req.params as { id: string };
    const { count } = await prisma.supplier.updateMany({
      where: { id, workspaceId: me.workspaceId },
      data: { status: 'archived' },
    });
    if (count === 0) return reply.code(404).send({ message: 'Supplier not found' });
    await writeAudit(prisma, {
      workspaceId: me.workspaceId,
      actorId: me.id,
      action: 'supplier.archive',
      resource: 'supplier',
      resourceId: id,
      ip: req.ip,
    });
    return { ok: true };
  });
}
