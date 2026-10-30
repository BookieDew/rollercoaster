import { createHmac } from 'crypto';

/**
 * V4 keyed RNG (contract §1). Every draw is one HMAC-SHA256 block:
 *   key = the full 32-byte ride seed, msg = "rc-v4|<label>|" + uint32 big-endian counter,
 *   uniform = top 53 bits of the block / 2^53, in [0, 1).
 * Draws are random-access by (label, counter), so one decision never shifts another.
 */
export const V4_STREAM_LABELS = ['duration', 'outcome', 'crash-time', 'crash-phase', 'shape', 'linear'] as const;
export type V4StreamLabel = (typeof V4_STREAM_LABELS)[number];

const SEED_PATTERN = /^[0-9a-fA-F]{64}$/;
const TWO_POW_21 = 2097152;
const TWO_POW_53 = 9007199254740992;
const MAX_COUNTER = 0xffffffff;

/** Validates and decodes a 64-hex seed. The error never echoes the seed. */
export function seedKey(seedHex: string): Buffer {
  if (typeof seedHex !== 'string' || !SEED_PATTERN.test(seedHex)) {
    throw new Error('V4 ride seed must be 64 hexadecimal characters');
  }
  return Buffer.from(seedHex, 'hex');
}

export function streamMessage(label: V4StreamLabel, counter: number): Buffer {
  if (!V4_STREAM_LABELS.includes(label)) throw new Error('Unknown V4 stream label');
  if (!Number.isInteger(counter) || counter < 0 || counter > MAX_COUNTER) {
    throw new Error('V4 stream counter must be a uint32');
  }
  const prefix = Buffer.from(`rc-v4|${label}|`, 'utf8');
  const message = Buffer.alloc(prefix.length + 4);
  prefix.copy(message, 0);
  message.writeUInt32BE(counter, prefix.length);
  return message;
}

export function streamBlock(key: Buffer, label: V4StreamLabel, counter: number): Buffer {
  return createHmac('sha256', key).update(streamMessage(label, counter)).digest();
}

export function blockToUniform(block: Buffer): number {
  return (block.readUInt32BE(0) * TWO_POW_21 + (block.readUInt32BE(4) >>> 11)) / TWO_POW_53;
}

export interface V4Streams {
  draw(label: V4StreamLabel, counter: number): number;
  /** Zeroes the key copy; later draws throw. */
  close(): void;
}

/** Memoized draws for one ride. Hold it only while building the ride. */
export function openStreams(seedHex: string): V4Streams {
  const key = seedKey(seedHex);
  const cache = new Map<string, number>();
  let open = true;
  return {
    draw(label, counter) {
      if (!open) throw new Error('V4 streams are closed');
      const id = `${label}|${counter}`;
      let value = cache.get(id);
      if (value === undefined) {
        value = blockToUniform(streamBlock(key, label, counter));
        cache.set(id, value);
      }
      return value;
    },
    close() {
      open = false;
      key.fill(0);
      cache.clear();
    },
  };
}
