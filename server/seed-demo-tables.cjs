const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const storeId = 'store-demo-001';
  const tables = [
    { id: 'table-a1-001', name: 'A1', sortOrder: 1 },
    { id: 'table-a2-001', name: 'A2', sortOrder: 2 },
    { id: 'table-b1-001', name: 'B1', sortOrder: 3 },
    { id: 'table-b2-001', name: 'B2', sortOrder: 4 },
  ];
  for (const t of tables) {
    await prisma.storeTable.upsert({
      where: { id: t.id },
      update: { name: t.name, sortOrder: t.sortOrder },
      create: { id: t.id, storeId, name: t.name, sortOrder: t.sortOrder, createdAt: new Date() },
    });
  }
  const count = await prisma.storeTable.count({ where: { storeId } });
  console.log(JSON.stringify({ ok: true, storeId, tables: count }));
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e.message); await prisma.$disconnect(); process.exit(1); });
