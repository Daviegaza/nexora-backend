import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireCap } from '../../lib/auth.js';
import { writeAudit } from '../../lib/audit.js';
import { isValidKraPin } from '../../lib/kra-tax.js';

const CustomerInput = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  county: z.string().optional(),
  town: z.string().optional(),
  type: z.enum(['retail', 'wholesale', 'corporate']).default('retail'),
  kraPin: z.string().optional(),
  notes: z.string().optional(),
});

export async function registerCustomerRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [requireCap('customers.read')] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    const q = (req.query as { q?: string })?.q;
    return prisma.customer.findMany({
      where: {
        workspaceId: me.workspaceId,
        status: 'active',
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { phone: { contains: q } },
                { email: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      take: 500,
    });
  });

  app.get('/:id', { preHandler: [requireCap('customers.read')] }, async (req, reply) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    const { id } = req.params as { id: string };
    const c = await prisma.customer.findFirst({
      where: { id, workspaceId: me.workspaceId },
      include: { transactions: { take: 20, orderBy: { createdAt: 'desc' } } },
    });
    if (!c) return reply.code(404).send({ message: 'Customer not found' });
    return c;
  });

  app.post(
    '/',
    { preHandler: [requireCap('customers.create')], schema: { body: CustomerInput } },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const b = req.body as z.infer<typeof CustomerInput>;
      if (b.kraPin && !isValidKraPin(b.kraPin)) {
        return reply.code(400).send({ message: 'Invalid KRA PIN format', code: 'BAD_KRA_PIN' });
      }
      const c = await prisma.customer.create({
        data: {
          workspaceId: me.workspaceId,
          name: b.name,
          email: b.email,
          phone: b.phone,
          county: b.county,
          town: b.town,
          type: b.type,
          notes: b.notes,
        },
      });
      await writeAudit(prisma, {
        workspaceId: me.workspaceId,
        actorId: me.id,
        action: 'customer.create',
        resource: 'customer',
        resourceId: c.id,
        ip: req.ip,
      });
      return c;
    },
  );

  app.put(
    '/:id',
    {
      preHandler: [requireCap('customers.update')],
      schema: { body: CustomerInput.partial() },
    },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const { id } = req.params as { id: string };
      const b = req.body as Partial<z.infer<typeof CustomerInput>>;
      if (b.kraPin && !isValidKraPin(b.kraPin)) {
        return reply.code(400).send({ message: 'Invalid KRA PIN format', code: 'BAD_KRA_PIN' });
      }
      const { count } = await prisma.customer.updateMany({
        where: { id, workspaceId: me.workspaceId },
        data: b,
      });
      if (count === 0) return reply.code(404).send({ message: 'Customer not found' });
      await writeAudit(prisma, {
        workspaceId: me.workspaceId,
        actorId: me.id,
        action: 'customer.update',
        resource: 'customer',
        resourceId: id,
        meta: b as Record<string, unknown>,
        ip: req.ip,
      });
      return prisma.customer.findUnique({ where: { id } });
    },
  );

  app.delete('/:id', { preHandler: [requireCap('customers.delete')] }, async (req, reply) => {
    const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
    const { id } = req.params as { id: string };
    const { count } = await prisma.customer.updateMany({
      where: { id, workspaceId: me.workspaceId },
      data: { status: 'archived' },
    });
    if (count === 0) return reply.code(404).send({ message: 'Customer not found' });
    await writeAudit(prisma, {
      workspaceId: me.workspaceId,
      actorId: me.id,
      action: 'customer.archive',
      resource: 'customer',
      resourceId: id,
      ip: req.ip,
    });
    return { ok: true };
  });
}
