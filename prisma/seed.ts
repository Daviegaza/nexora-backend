import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await argon2.hash('demo1234');
  const ws = await prisma.workspace.upsert({
    where: { id: 'demo-ws' },
    update: {},
    create: { id: 'demo-ws', name: 'Nexora Enterprises Ltd', plan: 'pro', kraPin: 'P051234567A' },
  });
  await prisma.user.upsert({
    where: { email: 'owner@nexora.co.ke' },
    update: {},
    create: { workspaceId: ws.id, name: 'James Mwangi', email: 'owner@nexora.co.ke', phone: '+254722123456', role: 'owner', passwordHash },
  });
  await prisma.branch.upsert({
    where: { id: 'br-nairobi' },
    update: {},
    create: { id: 'br-nairobi', workspaceId: ws.id, name: 'Nairobi HQ', county: 'Nairobi', location: 'CBD', status: 'active' },
  });
  console.log('Seeded demo workspace and owner: owner@nexora.co.ke / demo1234');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
