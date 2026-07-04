import { createHash } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

// Tamper-evident audit log — each row's `meta.hash` chains to previous row's.
// Verifiable at read time: recompute chain and compare hashes.
// Pattern: https://event-driven.io/en/audit_log_event_sourcing/
//
// NOTE: for maximum strength, `hash` should live in a dedicated column with
// an @@unique constraint. This helper writes it into the existing `meta` JSON
// so no schema change is needed; migrate to a column when ready.

export interface WriteAuditArgs {
  workspaceId: string;
  actorId?: string | null;
  action: string; // e.g. 'user.login', 'product.update', 'transaction.create'
  resource: string; // e.g. 'user', 'product', 'transaction'
  resourceId?: string | null;
  meta?: Record<string, unknown>;
  ip?: string | null;
}

function chainHash(prevHash: string, args: WriteAuditArgs, ts: string): string {
  const canonical = JSON.stringify({
    prev: prevHash,
    ts,
    workspaceId: args.workspaceId,
    actorId: args.actorId ?? null,
    action: args.action,
    resource: args.resource,
    resourceId: args.resourceId ?? null,
    meta: args.meta ?? {},
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export async function writeAudit(
  db: PrismaClient | Prisma.TransactionClient,
  args: WriteAuditArgs,
) {
  const ts = new Date().toISOString();
  const prev = await db.auditLog.findFirst({
    where: { workspaceId: args.workspaceId },
    orderBy: { createdAt: 'desc' },
    select: { meta: true },
  });
  const prevHash =
    (prev?.meta && typeof prev.meta === 'object' && !Array.isArray(prev.meta)
      ? ((prev.meta as Record<string, unknown>).hash as string | undefined)
      : undefined) ?? 'GENESIS';
  const hash = chainHash(prevHash, args, ts);
  return db.auditLog.create({
    data: {
      workspaceId: args.workspaceId,
      actorId: args.actorId ?? undefined,
      action: args.action,
      resource: args.resource,
      resourceId: args.resourceId ?? undefined,
      meta: { ...(args.meta ?? {}), hash, prev: prevHash } as Prisma.InputJsonValue,
      ip: args.ip ?? undefined,
    },
  });
}

// Verify chain integrity for a workspace. Returns first tampered row or null if OK.
export async function verifyAuditChain(
  db: PrismaClient | Prisma.TransactionClient,
  workspaceId: string,
): Promise<{ id: string; expected: string; found: string } | null> {
  const rows = await db.auditLog.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      workspaceId: true,
      actorId: true,
      action: true,
      resource: true,
      resourceId: true,
      meta: true,
      createdAt: true,
    },
  });
  let prevHash = 'GENESIS';
  for (const row of rows) {
    const meta = (
      row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
        ? (row.meta as Record<string, unknown>)
        : {}
    ) as Record<string, unknown>;
    const storedHash = meta.hash as string | undefined;
    const { hash: _hash, prev: _prev, ...userMeta } = meta;
    const expected = chainHash(
      prevHash,
      {
        workspaceId: row.workspaceId,
        actorId: row.actorId ?? undefined,
        action: row.action,
        resource: row.resource,
        resourceId: row.resourceId ?? undefined,
        meta: userMeta,
      },
      row.createdAt.toISOString(),
    );
    if (storedHash !== expected) {
      return { id: row.id, expected, found: storedHash ?? '(missing)' };
    }
    prevHash = expected;
  }
  return null;
}
