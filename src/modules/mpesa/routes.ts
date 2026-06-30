import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCap } from '../../lib/auth.js';
import { stkPush } from './service.js';
import { env } from '../../lib/env.js';

export async function registerMpesaRoutes(app: FastifyInstance) {
  app.post('/stk', {
    preHandler: [requireCap('mpesa.stk')],
    schema: { body: z.object({
      phone: z.string(), amount: z.number(), accountRef: z.string(),
      description: z.string().default('NEXORA Sale'),
    }) },
  }, async (req) => {
    const b = req.body as { phone: string; amount: number; accountRef: string; description: string };
    return stkPush({
      ...b,
      callbackUrl: `${env.MPESA_CALLBACK_BASE ?? ''}/api/mpesa/callback`,
    });
  });

  // Daraja callback (unauthenticated — Safaricom origin)
  app.post('/callback', async (req) => {
    req.log.info({ body: req.body }, 'mpesa callback');
    // TODO: parse stkCallback, match by CheckoutRequestID, update transaction
    return { ok: true };
  });
}
