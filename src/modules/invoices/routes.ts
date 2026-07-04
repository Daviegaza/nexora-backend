import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { prisma } from '../../lib/prisma.js';
import { requireCap } from '../../lib/auth.js';
import { writeAudit } from '../../lib/audit.js';
import { enqueue } from '../../lib/outbox.js';

const InvoiceInput = z.object({
  customerId: z.string(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        name: z.string(),
        price: z.number().nonnegative(),
        quantity: z.number().int().positive(),
        discount: z.number().nonnegative().default(0),
        total: z.number().nonnegative(),
      }),
    )
    .min(1),
  subtotal: z.number().nonnegative(),
  tax: z.number().nonnegative().default(0),
  total: z.number().nonnegative(),
  issuedDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
});

function newInvoiceNo(): string {
  return `INV-${new Date().getFullYear()}-${randomBytes(6).toString('hex').toUpperCase()}`;
}

export async function registerInvoiceRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [requireCap('invoices.read')] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    const q = req.query as { status?: string };
    return prisma.invoice.findMany({
      where: {
        workspaceId: me.workspaceId,
        ...(q.status ? { status: q.status } : {}),
      },
      include: { customer: true, items: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  });

  app.get('/:id', { preHandler: [requireCap('invoices.read')] }, async (req, reply) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    const { id } = req.params as { id: string };
    const inv = await prisma.invoice.findFirst({
      where: { id, workspaceId: me.workspaceId },
      include: { customer: true, items: true },
    });
    if (!inv) return reply.code(404).send({ message: 'Invoice not found' });
    return inv;
  });

  app.post(
    '/',
    { preHandler: [requireCap('invoices.create')], schema: { body: InvoiceInput } },
    async (req) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const b = req.body as z.infer<typeof InvoiceInput>;
      const number = newInvoiceNo();
      const inv = await prisma.invoice.create({
        data: {
          workspaceId: me.workspaceId,
          number,
          customerId: b.customerId,
          subtotal: b.subtotal,
          tax: b.tax,
          total: b.total,
          issuedDate: b.issuedDate,
          dueDate: b.dueDate,
          status: 'draft',
          items: {
            create: b.items.map((i) => ({
              productId: i.productId,
              name: i.name,
              price: i.price,
              quantity: i.quantity,
              discount: i.discount,
              total: i.total,
            })),
          },
        },
        include: { items: true, customer: true },
      });
      await writeAudit(prisma, {
        workspaceId: me.workspaceId,
        actorId: me.id,
        action: 'invoice.create',
        resource: 'invoice',
        resourceId: inv.id,
        meta: { number, total: b.total },
        ip: req.ip,
      });
      return inv;
    },
  );

  // Send: mark issued + enqueue eTIMS filing (invoices are also KRA-fileable).
  app.post('/:id/send', { preHandler: [requireCap('invoices.send')] }, async (req, reply) => {
    const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
    const { id } = req.params as { id: string };
    const inv = await prisma.invoice.findFirst({
      where: { id, workspaceId: me.workspaceId },
      include: { items: true, customer: true },
    });
    if (!inv) return reply.code(404).send({ message: 'Invoice not found' });
    if (inv.status !== 'draft') {
      return reply.code(409).send({ message: 'Invoice already sent', status: inv.status });
    }
    await prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id },
        data: { status: 'sent', issuedDate: inv.issuedDate ?? new Date() },
      });
      await enqueue(tx, {
        workspaceId: me.workspaceId,
        kind: 'etims.file',
        payload: {
          transactionId: inv.id,
          receiptNo: inv.number,
          tin: process.env.KRA_ETIMS_TIN ?? '',
          bhfId: process.env.KRA_ETIMS_BHF_ID ?? '00',
          items: inv.items.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            price: Number(i.price),
            taxRate: 0.16,
            tax: (Number(i.total) * 0.16) / 1.16,
          })),
          total: Number(inv.total),
          vat: Number(inv.tax),
        },
      });
    });
    await writeAudit(prisma, {
      workspaceId: me.workspaceId,
      actorId: me.id,
      action: 'invoice.send',
      resource: 'invoice',
      resourceId: id,
      ip: req.ip,
    });
    return { ok: true };
  });

  app.post('/:id/paid', { preHandler: [requireCap('invoices.mark_paid')] }, async (req, reply) => {
    const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
    const { id } = req.params as { id: string };
    const { count } = await prisma.invoice.updateMany({
      where: { id, workspaceId: me.workspaceId, status: { in: ['sent', 'overdue'] } },
      data: { status: 'paid', paidDate: new Date() },
    });
    if (count === 0) return reply.code(404).send({ message: 'Invoice not found or not payable' });
    await writeAudit(prisma, {
      workspaceId: me.workspaceId,
      actorId: me.id,
      action: 'invoice.paid',
      resource: 'invoice',
      resourceId: id,
      ip: req.ip,
    });
    return { ok: true };
  });

  app.post('/:id/cancel', { preHandler: [requireCap('invoices.cancel')] }, async (req, reply) => {
    const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
    const { id } = req.params as { id: string };
    const { count } = await prisma.invoice.updateMany({
      where: { id, workspaceId: me.workspaceId, status: { not: 'paid' } },
      data: { status: 'cancelled' },
    });
    if (count === 0) return reply.code(404).send({ message: 'Invoice not found or paid' });
    await writeAudit(prisma, {
      workspaceId: me.workspaceId,
      actorId: me.id,
      action: 'invoice.cancel',
      resource: 'invoice',
      resourceId: id,
      ip: req.ip,
    });
    return { ok: true };
  });
}
