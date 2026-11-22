'use strict';

/**
 * 临时脚本：为本机演示写入一家门店的演示数据（云栖小馆 / store-demo-001）。
 * 目的：让导出的微信小程序首页能真实拉到门店与菜品，验证微信运行时渲染。
 * 幂等：全部用 upsert，可重复执行；删除时按 store-demo-001 级联清理。
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const storeId = 'store-demo-001';
const now = new Date();

const categories = [
  { id: 'cat-noodle-001', name: '招牌面', sortOrder: 1 },
  { id: 'cat-side-001', name: '小食', sortOrder: 2 },
  { id: 'cat-drink-001', name: '饮品', sortOrder: 3 },
];

const products = [
  { id: 'prod-noodle-001', categoryId: 'cat-noodle-001', name: '雪菜肉丝面', description: '招牌，咸鲜微辣', priceCents: 2200, sortOrder: 1 },
  { id: 'prod-noodle-002', categoryId: 'cat-noodle-001', name: '葱油拌面', description: '现熬葱油，拌匀更香', priceCents: 1800, sortOrder: 2 },
  { id: 'prod-side-001', categoryId: 'cat-side-001', name: '时令小食拼盘', description: '每日现做，随季节调整', priceCents: 1600, sortOrder: 1 },
  { id: 'prod-drink-001', categoryId: 'cat-drink-001', name: '冰镇酸梅汤', description: '解腻，微酸回甘', priceCents: 800, sortOrder: 1 },
];

async function main() {
  await prisma.store.upsert({
    where: { id: storeId },
    update: { catalogVersion: 1, configVersion: 1, updatedAt: now },
    create: {
      id: storeId,
      name: '云栖小馆',
      category: '社区面馆',
      address: '',
      phone: '',
      businessHours: '10:00-14:00,17:00-21:00',
      dineInEnabled: true,
      takeawayEnabled: true,
      backgroundColor: '#F7F3EC',
      textColor: '#232323',
      primaryColor: '#B34A0F',
      catalogVersion: 1,
      configVersion: 1,
      createdAt: now,
      updatedAt: now,
    },
  });

  for (const category of categories) {
    await prisma.category.upsert({
      where: { id: category.id },
      update: { name: category.name, sortOrder: category.sortOrder },
      create: { ...category, storeId, createdAt: now },
    });
  }

  for (const product of products) {
    await prisma.product.upsert({
      where: { id: product.id },
      update: { name: product.name, description: product.description, priceCents: product.priceCents, available: true, sortOrder: product.sortOrder },
      create: { ...product, storeId, imageUrl: '', available: true, createdAt: now, updatedAt: now },
    });
  }

  const counts = {
    stores: await prisma.store.count({ where: { id: storeId } }),
    categories: await prisma.category.count({ where: { storeId } }),
    products: await prisma.product.count({ where: { storeId } }),
  };
  console.log(JSON.stringify({ ok: true, storeId, counts }));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, message: String(error && error.message) }));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
