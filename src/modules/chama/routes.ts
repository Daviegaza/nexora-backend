import type { FastifyInstance } from 'fastify';
import { requireAuth, requireCap } from '../../lib/auth.js';
import { prisma } from '../../lib/prisma.js';

export async function registerChamaRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [requireAuth] }, async (req) => {
    const me = (req as unknown as { me?: { workspaceId: string } }).me;
    const ws = me?.workspaceId;
    return { module: 'chama', workspaceId: ws ?? null, items: [] };
  });
  // TODO: implement create/update/delete with appropriate requireCap('...') preHandlers
}
