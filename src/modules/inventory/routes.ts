import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireCap } from '../../lib/auth.js';
import { writeAudit } from '../../lib/audit.js';

const AdjustInput = z.object({
  productId: z.string(),
  branchId: z.string(),
  delta: z.number().int(), // positive = stock in, negative = stock out
  reason: z.enum(['recount', 'damage', 'theft', 'return', 'transfer_in', 'transfer_out', 'other']),
  notes: z.string().optional(),
});

export async function registerInventoryRoutes(app: FastifyInstance) {
  // GET / — stock levels across a workspace (or branch)
  app.get('/', { preHandler: [requireCap('inventory.read')] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    const q = req.query as { branchId?: string; lowOnly?: string };
    // StockLevel doesn't have workspaceId directly — join via product.
    const levels = await prisma.stockLevel.findMany({
      where: {
        product: { workspaceId: me.workspaceId, deletedAt: null },
        ...(q.branchId ? { branchId: q.branchId } : {}),
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            minStock: true,
            unit: true,
            price: true,
            category: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 1000,
    });
    if (q.lowOnly === 'true') {
      return levels.filter((l) => l.quantity <= (l.product?.minStock ?? 0));
    }
    return levels;
  });

  // GET /movements — audit trail of stock changes
  app.get('/movements', { preHandler: [requireCap('inventory.read')] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    const q = req.query as { productId?: string; branchId?: string; limit?: string };
    return prisma.stockMovement.findMany({
      where: {
        product: { workspaceId: me.workspaceId },
        ...(q.productId ? { productId: q.productId } : {}),
        ...(q.branchId ? { branchId: q.branchId } : {}),
      },
      include: {
        product: { select: { id: true, name: true, sku: true } },
        branch: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(q.limit ?? 200), 1000),
    });
  });

  // POST /adjust — manual stock adjustment (recount, damage, etc).
  // Race-safe: negative delta uses conditional updateMany (fails if would go negative).
  app.post(
    '/adjust',
    { preHandler: [requireCap('inventory.adjust')], schema: { body: AdjustInput } },
    async (req, reply) => {
      const me = (req as unknown as { me: { workspaceId: string; id: string } }).me;
      const b = req.body as z.infer<typeof AdjustInput>;

      // Verify product belongs to workspace.
      const product = await prisma.product.findFirst({
        where: { id: b.productId, workspaceId: me.workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!product) return reply.code(404).send({ message: 'Product not found' });

      try {
        const result = await prisma.$transaction(async (tx) => {
          if (b.delta < 0) {
            const { count } = await tx.stockLevel.updateMany({
              where: {
                productId: b.productId,
                branchId: b.branchId,
                quantity: { gte: -b.delta },
              },
              data: { quantity: { decrement: -b.delta } },
            });
            if (count === 0) {
              throw new Error('INSUFFICIENT_STOCK');
            }
          } else {
            // upsert-style: create if missing, else increment.
            const existing = await tx.stockLevel.findFirst({
              where: { productId: b.productId, branchId: b.branchId },
            });
            if (existing) {
              await tx.stockLevel.update({
                where: { id: existing.id },
                data: { quantity: { increment: b.delta } },
              });
            } else {
              await tx.stockLevel.create({
                data: { productId: b.productId, branchId: b.branchId, quantity: b.delta },
              });
            }
          }
          const movement = await tx.stockMovement.create({
            data: {
              productId: b.productId,
              branchId: b.branchId,
              type: b.delta > 0 ? 'in' : 'out',
              quantity: Math.abs(b.delta),
              reference: b.reason,
              performedBy: me.id,
              notes: b.notes,
            },
          });
          return movement;
        });
        await writeAudit(prisma, {
          workspaceId: me.workspaceId,
          actorId: me.id,
          action: 'inventory.adjust',
          resource: 'stock',
          resourceId: b.productId,
          meta: { branchId: b.branchId, delta: b.delta, reason: b.reason },
          ip: req.ip,
        });
        return result;
      } catch (err) {
        if ((err as Error).message === 'INSUFFICIENT_STOCK') {
          return reply
            .code(409)
            .send({ message: 'Insufficient stock', code: 'INSUFFICIENT_STOCK' });
        }
        throw err;
      }
    },
  );
}
