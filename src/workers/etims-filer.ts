// BullMQ worker that drains JobOutbox rows of kind='etims.file' and files
// them to KRA. Idempotent — re-runs on failure until success or max attempts.
//
// Run as separate process:  node dist/workers/etims-filer.js
// (or `tsx src/workers/etims-filer.ts` in dev)

import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { fileEtimsInvoice } from '../modules/etims/service.js';

const QUEUE_NAME = 'etims-filer';
const MAX_ATTEMPTS = 8;
const POLL_INTERVAL_MS = 5_000;

if (!env.REDIS_URL) {
  throw new Error('REDIS_URL required for etims-filer worker');
}

// BullMQ ships its own ioredis; use `any`-cast to bridge the two type-nested copies.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null }) as any;
const queue = new Queue(QUEUE_NAME, { connection });

interface EtimsFilePayload {
  transactionId: string;
  receiptNo: string;
  tin: string;
  bhfId: string;
  items: Array<{
    name: string;
    quantity: number;
    price: number;
    taxRate: number;
    tax: number;
  }>;
  total: number;
  vat: number;
}

async function processJob(job: Job<{ outboxId: string }>) {
  const { outboxId } = job.data;
  const row = await prisma.jobOutbox.findUnique({ where: { id: outboxId } });
  if (!row) {
    logger.warn({ outboxId }, 'outbox row vanished; skipping');
    return;
  }
  if (row.status === 'done') return; // idempotent no-op on retry

  await prisma.jobOutbox.update({
    where: { id: outboxId },
    data: { status: 'processing', attempts: { increment: 1 } },
  });

  const payload = row.payload as unknown as EtimsFilePayload;
  try {
    const result = await fileEtimsInvoice({
      tin: payload.tin,
      bhfId: payload.bhfId,
      invoiceNo: payload.receiptNo,
      items: payload.items,
      total: payload.total,
      vat: payload.vat,
    });
    await prisma.$transaction([
      prisma.transaction.update({
        where: { id: payload.transactionId },
        data: {
          etimsStatus: 'filed',
          etimsRef: result.rcptNo,
          etimsQR: result.qrCode,
          etimsSubmissionId: result.internalData,
        },
      }),
      prisma.jobOutbox.update({
        where: { id: outboxId },
        data: { status: 'done', processedAt: new Date(), lastError: null },
      }),
    ]);
    logger.info({ outboxId, receiptNo: payload.receiptNo }, 'etims filed');
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const done = row.attempts + 1 >= MAX_ATTEMPTS;
    await prisma.jobOutbox.update({
      where: { id: outboxId },
      data: {
        status: done ? 'failed' : 'pending',
        lastError: message.slice(0, 500),
        // Exponential backoff — next attempt after 2^attempts minutes.
        runAfter: new Date(Date.now() + 2 ** row.attempts * 60_000),
      },
    });
    if (done) {
      await prisma.transaction.update({
        where: { id: payload.transactionId },
        data: { etimsStatus: 'failed' },
      });
    }
    logger.error({ outboxId, err: message, attempt: row.attempts + 1 }, 'etims filing failed');
    throw err; // let BullMQ mark job as failed too
  }
}

const worker = new Worker<{ outboxId: string }>(QUEUE_NAME, processJob, {
  connection,
  concurrency: 4,
});

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'worker job failed');
});

// Poller — scans outbox for due jobs and enqueues them.
// (In production replace with Postgres LISTEN/NOTIFY per architecture research.)
async function pollOutbox() {
  const due = await prisma.jobOutbox.findMany({
    where: { kind: 'etims.file', status: 'pending', runAfter: { lte: new Date() } },
    take: 100,
    orderBy: { runAfter: 'asc' },
  });
  for (const row of due) {
    await queue.add('file', { outboxId: row.id }, { jobId: `outbox-${row.id}` });
  }
  if (due.length) logger.info({ count: due.length }, 'enqueued etims jobs');
}

setInterval(() => {
  pollOutbox().catch((err) => logger.error({ err }, 'poll failed'));
}, POLL_INTERVAL_MS);

logger.info({ queue: QUEUE_NAME }, 'etims-filer worker started');

async function shutdown() {
  await worker.close();
  await queue.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
