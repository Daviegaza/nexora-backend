import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireCap } from '../../lib/auth.js';
import { writeAudit } from '../../lib/audit.js';

const LeadInput = z.object({
  name: z.string().min(1),
  company: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  source: z.string().optional(),
  stage: z
    .enum(['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost'])
    .default('new'),
  value: z.number().nonnegative().default(0),
  probability: z.number().min(0).max(100).default(10),
  assignedTo: z.string().optional(),
  nextFollowUp: z.coerce.date().optional(),
  notes: z.string().optional(),
});

export async function registerLeadRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [requireCap('crm.read')] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    const q = req.query as { stage?: string; assignedTo?: string };
    return prisma.lead.findMany({
      where: {
        workspaceId: me.workspaceId,
        ...(q.stage ? { stage: q.stage } : {}),
        ...(q.assignedTo ? { assignedTo: q.assignedTo } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });
  });

  app.post(
    '/',
    { preHandler: [requireCap('crm.write')], schema: { body: LeadInput } },
    async (req) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const b = req.body as z.infer<typeof LeadInput>;
      const lead = await prisma.lead.create({
        data: { workspaceId: me.workspaceId, ...b },
      });
      await writeAudit(prisma, {
        workspaceId: me.workspaceId,
        actorId: me.id,
        action: 'lead.create',
        resource: 'lead',
        resourceId: lead.id,
        ip: req.ip,
      });
      return lead;
    },
  );

  app.put(
    '/:id',
    { preHandler: [requireCap('crm.write')], schema: { body: LeadInput.partial() } },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const { id } = req.params as { id: string };
      const { count } = await prisma.lead.updateMany({
        where: { id, workspaceId: me.workspaceId },
        data: req.body as Partial<z.infer<typeof LeadInput>>,
      });
      if (count === 0) return reply.code(404).send({ message: 'Lead not found' });
      await writeAudit(prisma, {
        workspaceId: me.workspaceId,
        actorId: me.id,
        action: 'lead.update',
        resource: 'lead',
        resourceId: id,
        meta: req.body as Record<string, unknown>,
        ip: req.ip,
      });
      return prisma.lead.findUnique({ where: { id } });
    },
  );

  // CRM Kanban drag → PATCH stage
  app.patch(
    '/:id/stage',
    {
      preHandler: [requireCap('crm.write')],
      schema: {
        body: z.object({
          stage: z.enum([
            'new',
            'contacted',
            'qualified',
            'proposal',
            'negotiation',
            'won',
            'lost',
          ]),
        }),
      },
    },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const { id } = req.params as { id: string };
      const { stage } = req.body as { stage: string };
      const { count } = await prisma.lead.updateMany({
        where: { id, workspaceId: me.workspaceId },
        data: { stage },
      });
      if (count === 0) return reply.code(404).send({ message: 'Lead not found' });
      await writeAudit(prisma, {
        workspaceId: me.workspaceId,
        actorId: me.id,
        action: 'lead.stage_change',
        resource: 'lead',
        resourceId: id,
        meta: { stage },
        ip: req.ip,
      });
      return { ok: true };
    },
  );

  app.delete('/:id', { preHandler: [requireCap('crm.write')] }, async (req, reply) => {
    const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
    const { id } = req.params as { id: string };
    const { count } = await prisma.lead.deleteMany({
      where: { id, workspaceId: me.workspaceId },
    });
    if (count === 0) return reply.code(404).send({ message: 'Lead not found' });
    await writeAudit(prisma, {
      workspaceId: me.workspaceId,
      actorId: me.id,
      action: 'lead.delete',
      resource: 'lead',
      resourceId: id,
      ip: req.ip,
    });
    return { ok: true };
  });
}
