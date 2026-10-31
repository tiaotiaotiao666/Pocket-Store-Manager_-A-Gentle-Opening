import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';


export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/smart_store_test';

export const STORE_ID = 'store-demo-001';
export const OTHER_STORE_ID = 'store-other-001';
export const TABLE_ID = 'tbl_A01';
export const OTHER_TABLE_ID = 'tbl_other';
export const PRODUCT_AVAILABLE_ID = 'prd_beef_rice';
export const PRODUCT_SECOND_ID = 'prd_chicken_rice';
export const PRODUCT_UNAVAILABLE_ID = 'prd_seasonal';

export const OWNER_OPEN_ID = 'demo-owner-001';
export const STAFF_OPEN_ID = 'demo-staff-001';
export const CUSTOMER_OPEN_ID = 'demo-customer-001';
export const OTHER_CUSTOMER_OPEN_ID = 'demo-customer-002';
export const OTHER_OWNER_OPEN_ID = 'demo-owner-002';

export function prepareEnvironment(): void {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.CACHE_DRIVER = 'memory';
  process.env.ALLOW_DEMO_LOGIN = 'true';
  process.env.ALLOW_DEMO_PAYMENT = 'true';
  process.env.SESSION_TTL_SECONDS = '604800';
}

function testDatabaseName(): string {
  const url = new URL(TEST_DATABASE_URL);
  const database = url.pathname.replace(/^\//, '');
  if (!/^[A-Za-z0-9_]+$/.test(database) || !database.includes('test')) {
    throw new Error(`拒绝在非测试库上执行：${TEST_DATABASE_URL}`);
  }
  return database;
}

async function ensureDatabaseExists(): Promise<void> {
  const database = testDatabaseName();
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/mysql';
  const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
  } finally {
    await admin.$disconnect();
  }
}

export function createTestPrisma(): PrismaClient {
  return new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
}

export async function resetDatabase(): Promise<void> {
  const prisma = createTestPrisma();
  try {
    await prisma.storeImport.deleteMany();
    await prisma.orderStatusLog.deleteMany();
    await prisma.orderItem.deleteMany();
    await prisma.order.deleteMany();
    await prisma.idempotencyKey.deleteMany();
    await prisma.storeMember.deleteMany();
    await prisma.session.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
    await prisma.storeTable.deleteMany();
    await prisma.store.deleteMany();
    await prisma.user.deleteMany();
  } finally {
    await prisma.$disconnect();
  }
}

export async function seedDemoData(): Promise<void> {
  const prisma = createTestPrisma();
  const now = new Date();
  try {
    await prisma.store.create({
      data: {
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
    await prisma.store.create({
      data: {
        id: OTHER_STORE_ID,
        name: '隔壁小馆',
        businessHours: '09:00-20:00',
        createdAt: now,
        updatedAt: now,
      },
    });

    await prisma.category.createMany({
      data: [
        { id: 'cat_sig', storeId: STORE_ID, name: '招牌主食', sortOrder: 1, createdAt: now },
        { id: 'cat_snack', storeId: STORE_ID, name: '小食饮品', sortOrder: 2, createdAt: now },
        { id: 'cat_other', storeId: OTHER_STORE_ID, name: '隔壁菜单', sortOrder: 1, createdAt: now },
      ],
    });

    await prisma.product.createMany({
      data: [
        {
          id: PRODUCT_AVAILABLE_ID,
          storeId: STORE_ID,
          categoryId: 'cat_sig',
          name: '柑橘牛肉饭',
          description: '现炒牛肉，配时蔬',
          priceCents: 2800,
          sortOrder: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: PRODUCT_SECOND_ID,
          storeId: STORE_ID,
          categoryId: 'cat_sig',
          name: '柠香鸡腿饭',
          description: '低温慢烤',
          priceCents: 2600,
          sortOrder: 2,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: PRODUCT_UNAVAILABLE_ID,
          storeId: STORE_ID,
          categoryId: 'cat_snack',
          name: '季节限定甜品',
          description: '演示停售商品',
          priceCents: 1800,
          available: false,
          sortOrder: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    await prisma.storeTable.createMany({
      data: [
        { id: TABLE_ID, storeId: STORE_ID, name: 'A01', sortOrder: 1, createdAt: now },
        { id: 'tbl_A02', storeId: STORE_ID, name: 'A02', sortOrder: 2, createdAt: now },
        { id: OTHER_TABLE_ID, storeId: OTHER_STORE_ID, name: 'B01', sortOrder: 1, createdAt: now },
      ],
    });

    const users = [
      { id: 'usr_owner_001', openId: OWNER_OPEN_ID, displayName: '演示店主', role: Role.OWNER, storeId: STORE_ID },
      { id: 'usr_staff_001', openId: STAFF_OPEN_ID, displayName: '演示店员', role: Role.STAFF, storeId: STORE_ID },
      { id: 'usr_customer_001', openId: CUSTOMER_OPEN_ID, displayName: '演示顾客', role: null, storeId: STORE_ID },
      { id: 'usr_customer_002', openId: OTHER_CUSTOMER_OPEN_ID, displayName: '隔壁顾客', role: null, storeId: OTHER_STORE_ID },
      { id: 'usr_owner_002', openId: OTHER_OWNER_OPEN_ID, displayName: '隔壁店主', role: Role.OWNER, storeId: OTHER_STORE_ID },
    ];

    for (const user of users) {
      await prisma.user.create({
        data: {
          id: user.id,
          openId: user.openId,
          displayName: user.displayName,
          createdAt: now,
          updatedAt: now,
        },
      });
      if (user.role) {
        await prisma.storeMember.create({
          data: {
            id: `sm_${user.id.slice(4)}`,
            storeId: user.storeId,
            userId: user.id,
            role: user.role,
            createdAt: now,
          },
        });
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

export async function prepareDatabase(): Promise<void> {
  prepareEnvironment();
  await ensureDatabaseExists();
  execSync('npx prisma migrate deploy', {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
  await resetDatabase();
  await seedDemoData();
}

export async function createTestApp(): Promise<INestApplication> {
  // 动态导入：ConfigModule.forRoot 在 AppModule 求值时读取环境变量，
  // 必须晚于本文件 beforeAll 里的 prepareEnvironment / 生产环境覆盖。
  const { AppModule } = await import('../../src/app.module');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
  return app;
}

export async function loginAs(app: INestApplication, demoOpenId: string): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/wechat/login')
    .send({ demoOpenId });
  if (response.status !== 200 || typeof response.body.token !== 'string') {
    throw new Error(`演示登录失败：status=${response.status} body=${JSON.stringify(response.body)}`);
  }
  return response.body.token;
}

export function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function idempotencyHeader(key: string): Record<string, string> {
  return { 'Idempotency-Key': key };
}

export function createOrderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    storeId: STORE_ID,
    fulfillmentType: 'DINE_IN',
    tableId: TABLE_ID,
    items: [{ productId: PRODUCT_AVAILABLE_ID, quantity: 2 }],
    note: '少辣',
    ...overrides,
  };
}

export function uniqueKey(prefix = 'idem'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}