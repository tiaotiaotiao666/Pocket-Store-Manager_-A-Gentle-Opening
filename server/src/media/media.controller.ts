import {
  BadRequestException,
  Controller,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StoreOwnerGuard } from '../common/auth/store-owner.guard';
import { SessionAuthGuard } from '../common/auth/session-auth.guard';
import { AppError } from '../common/http/app-error';
import { readStringParam } from '../common/http/request-context';
import type { AppRequest } from '../common/http/request-context';
import { resolveMediaStorageDirectory } from './media-storage';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_EDGE = 6000;

interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

interface ImageInfo {
  extension: 'jpg' | 'png';
  contentType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
}

function dimensionsAreSafe(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width <= MAX_IMAGE_EDGE && height <= MAX_IMAGE_EDGE;
}

function inspectImage(buffer: Buffer): ImageInfo | null {
  const isPng = buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    buffer.toString('ascii', 12, 16) === 'IHDR';
  if (isPng) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return dimensionsAreSafe(width, height)
      ? { extension: 'png', contentType: 'image/png', width, height }
      : null;
  }

  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length && offset < 256 * 1024) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    const isFrame = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
    if (isFrame && length >= 7) {
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return dimensionsAreSafe(width, height)
        ? { extension: 'jpg', contentType: 'image/jpeg', width, height }
        : null;
    }
    offset += length;
  }
  return null;
}

@Controller('media')
export class MediaController {
  @Post('stores/:storeId/images')
  @UseGuards(SessionAuthGuard, StoreOwnerGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  async uploadStoreImage(
    @Req() request: AppRequest & Request,
    @UploadedFile() file?: UploadedImage,
  ): Promise<{ url: string; width: number; height: number; size: number }> {
    const storeId = readStringParam(request.params?.storeId);
    if (!storeId) throw new BadRequestException('缺少门店信息。');
    if (!file || !Buffer.isBuffer(file.buffer) || file.size <= 0) {
      throw new BadRequestException('请选择一张图片后再上传。');
    }

    const image = inspectImage(file.buffer);
    if (!image || (file.mimetype !== image.contentType && file.mimetype !== 'application/octet-stream')) {
      throw new AppError(422, 'IMAGE_INVALID', '图片格式无效，请选择 JPG 或 PNG 图片。');
    }
    if (file.size > MAX_IMAGE_BYTES) {
      throw new AppError(413, 'IMAGE_TOO_LARGE', '图片不能超过 5 MB，请压缩后重试。');
    }

    const storeDirectory = createHash('sha256').update(storeId).digest('hex').slice(0, 32);
    const fileName = randomUUID() + '.' + image.extension;
    const root = resolveMediaStorageDirectory();
    const directory = join(root, storeDirectory);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, fileName), file.buffer, { flag: 'wx' });

    const configuredOrigin = (process.env.PUBLIC_API_ORIGIN || '').trim().replace(/\/+$/, '');
    const requestOrigin = request.get('host') ? `${request.protocol}://${request.get('host')}` : '';
    const origin = configuredOrigin || requestOrigin;
    if (!origin) throw new AppError(500, 'MEDIA_ORIGIN_UNAVAILABLE', '无法生成图片访问地址。');

    return {
      url: `${origin}/uploads/${storeDirectory}/${fileName}`,
      width: image.width,
      height: image.height,
      size: file.size,
    };
  }
}
