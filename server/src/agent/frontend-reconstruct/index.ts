/**
 * frontend-reconstruct.v1 公共出口。
 *
 * P1 起增加只读能力事实、提示词与四个工具；Controller/Service 仍由 AgentModule
 * 直接引用，避免把 Nest 生命周期细节暴露给契约使用方。
 */
export * from './types';
export * from './errors';
export * from './schema';
export * from './state';
export * from './capabilities';
export * from './page-facts';
export * from './prompt';
export * from './tools';
