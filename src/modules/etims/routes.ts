import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { requireCap } from '../../lib/auth.js';
import { fileEtimsInvoice, cancelEtimsInvoice } from './service.js';

export async function registerEtimsRoutes(app: FastifyInstance) {
  app.post('/file/:txnId', { preHandler: [requireCap('etims.file')] }, async (req) => {
    const { txnId } = req.params as { txnId: string };
    const t = await prisma.transaction.findUnique({ where: { id: txnId }, include: { items: true } });
    if (!t) throw new Error('Transaction not found');
    const r = await fileEtimsInvoice({
      tin: process.env.KRA_ETIMS_TIN ?? '',
      bhfId: process.env.KRA_ETIMS_BHF_ID ?? '00',
      invoiceNo: t.receiptNo,
      items: t.items.map((i) => ({ name: i.name, quantity: i.quantity, price: Number(i.price), tax: Number(i.total) * 0.16 })),
      total: Number(t.total), vat: Number(t.tax),
    });
    await prisma.transaction.update({
      where: { id: txnId },
      data: { etimsStatus: 'filed', etimsRef: r.rcptNo, etimsQR: r.qrCode },
    });
    return r;
  });

  app.post('/cancel/:invoiceNo', { preHandler: [requireCap('etims.cancel')] }, async (req) => {
    const { invoiceNo } = req.params as { invoiceNo: string };
    return cancelEtimsInvoice(invoiceNo);
  });
}
