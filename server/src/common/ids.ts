import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const ID_LENGTH = 26;

function encodeTime(timestamp: number, length: number): string {
  let value = Math.floor(timestamp);
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out = CROCKFORD[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function randomBody(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += CROCKFORD[bytes[index] % 32];
  }
  return out;
}

export function createId(prefix: string): string {
  if (!/^[a-z]{1,4}$/.test(prefix)) {
    throw new Error(`ID 前缀不合法：${prefix}`);
  }
  const bodyLength = ID_LENGTH - prefix.length - 1;
  const randomLength = Math.max(bodyLength - TIME_LENGTH, 4);
  return `${prefix}_${encodeTime(Date.now(), TIME_LENGTH)}${randomBody(randomLength)}`.slice(0, ID_LENGTH);
}