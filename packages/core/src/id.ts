import { randomBytes } from 'node:crypto';

let lastTimestamp = 0;
let sequence = 0;

/**
 * RFC 9562 UUIDv7. Monotonic within this process for identifiers created in
 * the same millisecond; database uniqueness remains the final guard.
 */
export function uuidv7(now = Date.now()): string {
  if (now === lastTimestamp) {
    sequence = (sequence + 1) & 0x0fff;
  } else {
    lastTimestamp = now;
    sequence = randomBytes(2).readUInt16BE() & 0x0fff;
  }

  const bytes = randomBytes(16);
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function externalRef(prefix: string): string {
  return `${prefix}_${uuidv7().replaceAll('-', '')}`;
}
