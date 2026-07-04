import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireCap } from '../../lib/auth.js';
import { prisma } from '../../lib/prisma.js';
import { stkPush } from './service.js';
import { env } from '../../lib/env.js';

// Safaricom Daraja callback source ranges (public Safaricom infra).
// See https://developer.safaricom.co.ke; keep as env-overridable allowlist.
const DEFAULT_SAFARICOM_CIDRS = [
  '196.201.214.0/24',
  '196.201.212.0/24',
  '196.201.213.0/24',
  '196.201.215.0/24',
];

function ipInCidr(ip: string, cidr: string): boolean {
  const parts = cidr.split('/');
  const range = parts[0] ?? cidr;
  const bits = Number(parts[1] ?? 32);
  const toInt = (a: string) => a.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(range) & mask);
}

function safaricomAllowlisted(req: FastifyRequest): boolean {
  const cidrs = (env.MPESA_CALLBACK_CIDRS ?? DEFAULT_SAFARICOM_CIDRS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = req.ip.replace(/^::ffff:/, '');
  if (env.NODE_ENV !== 'production') return true;
  return cidrs.some((c) => ipInCidr(ip, c));
}

export async function registerMpesaRoutes(app: FastifyInstance) {
  app.post(
    '/stk',
    {
      preHandler: [requireCap('mpesa.stk')],
      schema: {
        body: z.object({
          phone: z.string(),
          amount: z.number().int().positive(),
          accountRef: z.string(),
          description: z.string().default('NEXORA Sale'),
          transactionId: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const me = (req as unknown as { me: { workspaceId: string } }).me;
      const b = req.body as {
        phone: string;
        amount: number;
        accountRef: string;
        description: string;
        transactionId?: string;
      };
      const res = await stkPush({
        phone: b.phone,
        amount: b.amount,
        accountRef: b.accountRef,
        description: b.description,
        callbackUrl: `${env.MPESA_CALLBACK_BASE ?? ''}/api/mpesa/callback`,
      });
      // Persist an intent record so callback can reconcile idempotently.
      if (res.CheckoutRequestID) {
        await prisma.mpesaPayment.create({
          data: {
            workspaceId: me.workspaceId,
            transactionId: b.transactionId,
            checkoutRequestId: res.CheckoutRequestID,
            merchantRequestId: res.MerchantRequestID ?? null,
            phone: b.phone,
            amount: b.amount,
            accountRef: b.accountRef,
            status: 'pending',
          },
        });
      }
      return res;
    },
  );

  // Daraja callback — unauthenticated, IP-allowlisted.
  // Safaricom retries on non-2xx, so we MUST be idempotent.
  app.post('/callback', { config: { rateLimit: false } }, async (req, reply) => {
    if (!safaricomAllowlisted(req)) {
      req.log.warn({ ip: req.ip }, 'mpesa callback from non-allowlisted ip');
      return reply.code(403).send({ ResultCode: 1, ResultDesc: 'forbidden' });
    }
    const body = req.body as { Body?: { stkCallback?: DarajaStkCallback } } | undefined;
    const cb = body?.Body?.stkCallback;
    if (!cb || !cb.CheckoutRequestID) {
      req.log.warn({ body }, 'mpesa callback missing stkCallback');
      // Return 200 so Safaricom stops retrying an unparseable payload.
      return { ResultCode: 0, ResultDesc: 'ignored' };
    }
    const items = cb.CallbackMetadata?.Item ?? [];
    const receiptRef = items.find((i) => i.Name === 'MpesaReceiptNumber')?.Value as
      string | undefined;

    const status =
      cb.ResultCode === 0 ? 'success' : cb.ResultCode === 1032 ? 'cancelled' : 'failed';

    // Idempotent upsert — CheckoutRequestID is @unique.
    const payment = await prisma.mpesaPayment.findUnique({
      where: { checkoutRequestId: cb.CheckoutRequestID },
    });
    if (!payment) {
      req.log.warn({ cid: cb.CheckoutRequestID }, 'mpesa callback for unknown request');
      return { ResultCode: 0, ResultDesc: 'unknown' };
    }
    if (payment.status !== 'pending') {
      // Already reconciled — Safaricom retry.
      return { ResultCode: 0, ResultDesc: 'duplicate' };
    }

    await prisma.$transaction(async (tx) => {
      await tx.mpesaPayment.update({
        where: { checkoutRequestId: cb.CheckoutRequestID },
        data: {
          status,
          resultCode: cb.ResultCode,
          resultDesc: cb.ResultDesc,
          receiptRef: receiptRef ?? null,
          callbackAt: new Date(),
        },
      });
      if (status === 'success' && payment.transactionId) {
        await tx.transaction.update({
          where: { id: payment.transactionId },
          data: {
            status: 'completed',
            mpesaRef: receiptRef ?? undefined,
          },
        });
      }
    });

    return { ResultCode: 0, ResultDesc: 'ok' };
  });

  // Client-facing polling endpoint — used by POS to check STK status after push.
  app.get('/status/:checkoutRequestId', { preHandler: [requireCap('mpesa.stk')] }, async (req) => {
    const me = (req as unknown as { me: { workspaceId: string } }).me;
    const { checkoutRequestId } = req.params as { checkoutRequestId: string };
    const p = await prisma.mpesaPayment.findFirst({
      where: { checkoutRequestId, workspaceId: me.workspaceId },
    });
    if (!p) return { status: 'unknown' };
    return {
      status: p.status,
      resultCode: p.resultCode,
      resultDesc: p.resultDesc,
      receiptRef: p.receiptRef,
    };
  });
}

interface DarajaStkCallback {
  MerchantRequestID?: string;
  CheckoutRequestID: string;
  ResultCode: number;
  ResultDesc?: string;
  CallbackMetadata?: { Item: Array<{ Name: string; Value?: string | number }> };
}
