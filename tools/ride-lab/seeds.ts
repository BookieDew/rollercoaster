import { createHmac } from 'crypto';

/** Reproducible 64-hex ride seeds: HMAC-SHA256(key = seedBase, msg = "ride-lab|<label>|<counter>"). */
export function seedAt(seedBase: string, label: string, counter: number): string {
  return createHmac('sha256', seedBase).update(`ride-lab|${label}|${counter}`).digest('hex');
}

/** Uniform [0,1) from the top 53 bits of an HMAC block. */
export function uniformAt(seedBase: string, label: string, counter: number): number {
  const block = createHmac('sha256', seedBase).update(`ride-lab|${label}|${counter}`).digest();
  const hi = block.readUInt32BE(0) * 2 ** 21 + (block.readUInt32BE(4) >>> 11);
  return hi / 2 ** 53;
}

/** Sequential uniform stream for a label. */
export function uniformStream(seedBase: string, label: string): () => number {
  let counter = 0;
  return () => uniformAt(seedBase, label, counter++);
}
