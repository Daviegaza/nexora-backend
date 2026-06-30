import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireCap } from '../../lib/auth.js';

const ProductInput = z.object({
  name: z.string(), sku: z.string(), barcode: z.string().optional(),
  category: z.string(), price: z.number(), cost: z.number(),
  unit: z.string().default('pc'), taxRate: z.number().default(0.16),
  minStock: z.number().default(0), supplierId: z.string().optional(),
});

export async function registerProductRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [requireCap('products.read')] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    return prisma.product.findMany({ where: { workspaceId: me.workspaceId }, orderBy: { name: 'asc' } });
  });

  app.get('/barcode/:code', { preHandler: [requireCap('products.read')] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    const { code } = req.params as { code: string };
    return prisma.product.findFirst({
      where: { workspaceId: me.workspaceId, OR: [{ barcode: code }, { sku: code }] },
    });
  });

  app.post('/', { preHandler: [requireCap('products.create')], schema: { body: ProductInput } }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    return prisma.product.create({ data: { ...(req.body as z.infer<typeof ProductInput>), workspaceId: me.workspaceId } });
  });

  app.put('/:id', { preHandler: [requireCap('products.update')], schema: { body: ProductInput.partial() } }, async (req) => {
    const { id } = req.params as { id: string };
    return prisma.product.update({ where: { id }, data: req.body as Partial<z.infer<typeof ProductInput>> });
  });

  app.delete('/:id', { preHandler: [requireCap('products.delete')] }, async (req) => {
    const { id } = req.params as { id: string };
    await prisma.product.delete({ where: { id } });
    return { ok: true };
  });
}
