import { resolve } from 'node:path';

const DEFAULT_UPLOAD_DIRECTORY_NAME = 'uploads';

/**
 * 上传目录必须同时被 main.ts（静态托管）与 MediaController（写入）使用。
 * 以本模块所在目录为锚点：src/media 与 dist/media 上跳两级都落在 server/ 下，
 * 避免 main.ts 与 controller 因 __dirname 深度不同读写到不同目录。
 */
export function resolveMediaStorageDirectory(): string {
  const configured = (process.env.MEDIA_STORAGE_DIR || '').trim();
  if (configured) {
    return resolve(configured);
  }
  return resolve(__dirname, '..', '..', DEFAULT_UPLOAD_DIRECTORY_NAME);
}