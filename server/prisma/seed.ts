import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();
const now = new Date();

const STORE_ID = 'store-demo-001';

async function seedStore() {
  return prisma.store.upsert({
    where: { id: STORE_ID },
    update: {
      name: '柑橘小馆',
      address: '示范市演示路 1 号',
      phone: '000-0000-0000',
      businessHours: '10:00-21:00',
      dineInEnabled: true,
      takeawayEnabled: true,
      backgroundColor: '#F7F3EC',
      textColor: '#232323',
      primaryColor: '#E86A17',
      updatedAt: now,
    },
    create: {
      id: STORE_ID,
      name: '柑橘小馆',
      category: '社区餐馆',
      address: '示范市演示路 1 号',
      phone: '000-0000-0000',
      businessHours: '10:00-21:00',
      dineInEnabled: true,
      takeawayEnabled: true,
      backgroundColor: '#F7F3EC',
      textColor: '#232323',
      primaryColor: '#E86A17',
      catalogVersion: 1,
      configVersion: 1,
      createdAt: now,
      updatedAt: now,
    },
  });
}

async function seedCategories() {
  const categories = [
    { id: 'cat_sig', name: '招牌主食', sortOrder: 1 },
    { id: 'cat_snack', name: '小食饮品', sortOrder: 2 },
  ];
  for (const category of categories) {
    await prisma.category.upsert({
      where: { id: category.id },
      update: { name: category.name, sortOrder: category.sortOrder },
      create: { ...category, storeId: STORE_ID, createdAt: now },
    });
  }
}

async function seedProducts() {
  const products = [
    { id: 'prd_beef_rice', categoryId: 'cat_sig', name: '柑橘牛肉饭', description: '现炒牛肉，配时蔬', priceCents: 2800, sortOrder: 1 },
    { id: 'prd_chicken_rice', categoryId: 'cat_sig', name: '柠香鸡腿饭', description: '低温慢烤，清爽不腻', priceCents: 2600, sortOrder: 2 },
    { id: 'prd_signature_noodle', categoryId: 'cat_sig', name: '招牌拌面', description: '每日现拌，微辣可选', priceCents: 2200, sortOrder: 3 },
    { id: 'prd_snack_platter', categoryId: 'cat_snack', name: '时令小食拼盘', description: '清爽搭配，适合分享', priceCents: 1600, sortOrder: 1 },
    { id: 'prd_tea', categoryId: 'cat_snack', name: '自选鲜泡茶', description: '每日现泡', priceCents: 1000, sortOrder: 2 },
    { id: 'prd_seasonal', categoryId: 'cat_snack', name: '季节限定甜品', description: '演示停售商品', priceCents: 1800, sortOrder: 3, available: false },
  ];
  for (const product of products) {
    await prisma.product.upsert({
      where: { id: product.id },
      update: {
        name: product.name,
        description: product.description,
        priceCents: product.priceCents,
        sortOrder: product.sortOrder,
        available: product.available ?? true,
        categoryId: product.categoryId,
        updatedAt: now,
      },
      create: {
        id: product.id,
        storeId: STORE_ID,
        categoryId: product.categoryId,
        name: product.name,
        description: product.description,
        priceCents: product.priceCents,
        sortOrder: product.sortOrder,
        available: product.available ?? true,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
}

async function seedTables() {
  const tables = [
    { id: 'tbl_A01', name: 'A01', sortOrder: 1 },
    { id: 'tbl_A02', name: 'A02', sortOrder: 2 },
  ];
  for (const table of tables) {
    await prisma.storeTable.upsert({
      where: { id: table.id },
      update: { name: table.name, sortOrder: table.sortOrder },
      create: { ...table, storeId: STORE_ID, createdAt: now },
    });
  }
}

async function seedUsers() {
  const users = [
    { id: 'usr_demo_owner', openId: process.env.DEMO_OWNER_OPEN_ID || 'demo-owner-001', displayName: '演示店主', role: Role.OWNER },
    { id: 'usr_demo_staff', openId: process.env.DEMO_STAFF_OPEN_ID || 'demo-staff-001', displayName: '演示店员', role: Role.STAFF },
    { id: 'usr_demo_customer', openId: process.env.DEMO_CUSTOMER_OPEN_ID || 'demo-customer-001', displayName: '演示顾客', role: null },
  ];

  for (const user of users) {
    await prisma.user.upsert({
      where: { openId: user.openId },
      update: { displayName: user.displayName, updatedAt: now },
      create: {
        id: user.id,
        openId: user.openId,
        displayName: user.displayName,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (user.role) {
      const saved = await prisma.user.findUniqueOrThrow({ where: { openId: user.openId } });
      await prisma.storeMember.upsert({
        where: { storeId_userId: { storeId: STORE_ID, userId: saved.id } },
        update: { role: user.role },
        create: { id: `sm_${saved.id.slice(-8)}`, storeId: STORE_ID, userId: saved.id, role: user.role, createdAt: now },
      });
    }
  }
}

async function main() {
  await seedStore();
  await seedCategories();
  await seedProducts();
  await seedTables();
  await seedUsers();
  const summary = {
    store: STORE_ID,
    categories: await prisma.category.count({ where: { storeId: STORE_ID } }),
    products: await prisma.product.count({ where: { storeId: STORE_ID } }),
    tables: await prisma.storeTable.count({ where: { storeId: STORE_ID } }),
    members: await prisma.storeMember.count({ where: { storeId: STORE_ID } }),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });