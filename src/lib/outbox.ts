import type { Prisma, PrismaClient } from '@prisma/client';

// Write a job into the outbox from inside a Prisma $transaction so the job is
// atomic with its domain write. Workers drain the outbox and retry idempotently.
export async function enqueue(
  tx: Prisma.TransactionClient | PrismaClient,
  args: {
    workspaceId: string;
    kind: string;
    payload: Record<string, unknown>;
    runAfter?: Date;
  },
) {
  return tx.jobOutbox.create({
    data: {
      workspaceId: args.workspaceId,
      kind: args.kind,
      payload: args.payload as Prisma.InputJsonValue,
      runAfter: args.runAfter ?? new Date(),
    },
  });
}
