import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { prisma } from '../../lib/prisma.js';
import { requireCap } from '../../lib/auth.js';
import { enqueue } from '../../lib/outbox.js';

class InsufficientStockError extends Error {
  statusCode = 409;
  code = 'INSUFFICIENT_STOCK';
  constructor(
    public productId: string,
    public available: number,
    public requested: number,
  ) {
    super(`Insufficient stock for product ${productId}: have ${available}, need ${requested}`);
  }
}

function newReceiptNo(): string {
  // 16 hex chars → collision probability negligible at Kenya SMB volumes
  // (birthday bound ~ 2^32 receipts before 50% collision, per workspace).
  return `RCP-${new Date().getFullYear()}-${randomBytes(8).toString('hex').toUpperCase()}`;
}

const TxnInput = z.object({
  customerId: z.string().optional(),
  branchId: z.string(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        name: z.string(),
        price: z.number(),
        quantity: z.number(),
        total: z.number(),
        discount: z.number().default(0),
      }),
    )
    .min(1),
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

  app.post(
    '/',
    { preHandler: [requireCap('pos.sell')], schema: { body: TxnInput } },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const b = req.body as z.infer<typeof TxnInput>;
      const receiptNo = newReceiptNo();

      // Load real product tax rates from DB (client-side rate is not trusted).
      const productIds = Array.from(new Set(b.items.map((i) => i.productId)));
      const products = await prisma.product.findMany({
        where: { id: { in: productIds }, workspaceId: me.workspaceId, deletedAt: null },
        select: { id: true, taxRate: true },
      });
      const taxRateById = new Map<string, number>(products.map((p) => [p.id, Number(p.taxRate)]));

      // Recompute tax per-line server-side, then per-transaction.
      const itemsWithTax = b.items.map((i) => {
        const rate = taxRateById.get(i.productId) ?? 0;
        // VAT-inclusive lines: tax = total * rate / (1 + rate).
        const lineTax = Math.round(((i.total * rate) / (1 + rate)) * 100) / 100;
        return { ...i, taxRate: rate, lineTax };
      });
      const computedTax = Math.round(itemsWithTax.reduce((s, i) => s + i.lineTax, 0) * 100) / 100;

      try {
        const txn = await prisma.$transaction(async (tx) => {
          const t = await tx.transaction.create({
            data: {
              workspaceId: me.workspaceId,
              receiptNo,
              customerId: b.customerId,
              branchId: b.branchId,
              cashierId: me.id,
              subtotal: b.subtotal,
              discount: b.discount,
              tax: computedTax,
              total: b.total,
              paymentMethod: b.paymentMethod,
              mpesaRef: b.mpesaRef,
              items: {
                create: itemsWithTax.map((i) => ({
                  productId: i.productId,
                  name: i.name,
                  price: i.price,
                  quantity: i.quantity,
                  discount: i.discount,
                  total: i.total,
                })),
              },
            },
            include: { items: true },
          });

          // Race-safe stock decrement — only decrements when quantity >= requested.
          // Under concurrent sales, whichever transaction runs first "wins" the stock;
          // the loser sees count === 0 and we abort the whole txn.
          for (const i of b.items) {
            const { count } = await tx.stockLevel.updateMany({
              where: {
                productId: i.productId,
                branchId: b.branchId,
                quantity: { gte: i.quantity },
              },
              data: { quantity: { decrement: i.quantity } },
            });
            if (count === 0) {
              const current = await tx.stockLevel.findFirst({
                where: { productId: i.productId, branchId: b.branchId },
                select: { quantity: true },
              });
              throw new InsufficientStockError(i.productId, current?.quantity ?? 0, i.quantity);
            }
            await tx.stockMovement.create({
              data: {
                productId: i.productId,
                branchId: b.branchId,
                type: 'out',
                quantity: i.quantity,
                reference: receiptNo,
                performedBy: me.id,
              },
            });
          }

          // Persisted outbox job — filing survives crash between sale + KRA response.
          // Payload uses the real KRA eTIMS `saveTrnsSalesOsdc` shape per v2.0 spec.
          await enqueue(tx, {
            workspaceId: me.workspaceId,
            kind: 'etims.file',
            payload: {
              transactionId: t.id,
              receiptNo,
              tin: process.env.KRA_ETIMS_TIN ?? '',
              bhfId: process.env.KRA_ETIMS_BHF_ID ?? '00',
              items: itemsWithTax.map((i) => ({
                name: i.name,
                quantity: i.quantity,
                price: i.price,
                taxRate: i.taxRate,
                tax: i.lineTax,
              })),
              total: b.total,
              vat: computedTax,
            },
          });

          return t;
        });

        return txn;
      } catch (err) {
        if (err instanceof InsufficientStockError) {
          return reply.code(409).send({
            message: err.message,
            code: err.code,
            productId: err.productId,
            available: err.available,
            requested: err.requested,
          });
        }
        throw err;
      }
    },
  );
}
