export const WECHAT_FETCH = Symbol('WECHAT_FETCH');

export type WechatFetch = (input: string, init?: RequestInit) => Promise<Response>;