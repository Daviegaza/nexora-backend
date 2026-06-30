import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireCap } from '../../lib/auth.js';
import { fileEtimsInvoice } from '../etims/service.js';

const TxnInput = z.object({
  customerId: z.string().optional(),
  branchId: z.string(),
  items: z.array(z.object({
    productId: z.string(), name: z.string(),
    price: z.number(), quantity: z.number(), total: z.number(),
    discount: z.number().default(0),
  })).min(1),
  subtotal: z.number(),
  discount: z.number().default(0),
  tax: z.number(),
  total: z.number(),
  paymentMethod: z.enum(['cash', 'mpesa', 'card', 'split']),
  mpesaRef: z.string().optional(),
});

export async function registerTransactionRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [requireCap('reports.view')] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    return prisma.transaction.findMany({
      where: { workspaceId: me.workspaceId },
      include: { items: true, customer: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  app.post('/', { preHandler: [requireCap('pos.sell')], schema: { body: TxnInput } }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
    const b = req.body as z.infer<typeof TxnInput>;
    const receiptNo = `RCP-${new Date().getFullYear()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    const txn = await prisma.$transaction(async (tx) => {
      const t = await tx.transaction.create({
        data: {
          workspaceId: me.workspaceId, receiptNo,
          customerId: b.customerId, branchId: b.branchId, cashierId: me.id,
          subtotal: b.subtotal, discount: b.discount, tax: b.tax, total: b.total,
          paymentMethod: b.paymentMethod, mpesaRef: b.mpesaRef,
          items: { create: b.items.map((i) => ({
            productId: i.productId, name: i.name, price: i.price,
            quantity: i.quantity, discount: i.discount, total: i.total,
          })) },
        },
        include: { items: true },
      });
      // Decrement stock
      for (const i of b.items) {
        await tx.stockLevel.updateMany({
          where: { productId: i.productId, branchId: b.branchId },
          data: { quantity: { decrement: i.quantity } },
        });
        await tx.stockMovement.create({
          data: {
            productId: i.productId, branchId: b.branchId, type: 'out',
            quantity: i.quantity, reference: receiptNo, performedBy: me.id,
          },
        });
      }
      return t;
    });

    // Fire-and-forget eTIMS filing (TODO: move to BullMQ queue)
    void fileEtimsInvoice({
      tin: process.env.KRA_ETIMS_TIN ?? '',
      bhfId: process.env.KRA_ETIMS_BHF_ID ?? '00',
      invoiceNo: receiptNo,
      items: b.items.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price, tax: i.total * 0.16 })),
      total: b.total, vat: b.tax,
    }).then(async (r) => {
      await prisma.transaction.update({
        where: { id: txn.id },
        data: { etimsStatus: 'filed', etimsRef: r.rcptNo, etimsQR: r.qrCode },
      });
    }).catch(async () => {
      await prisma.transaction.update({ where: { id: txn.id }, data: { etimsStatus: 'queued' } });
    });

    return txn;
  });
}
