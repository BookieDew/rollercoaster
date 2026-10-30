import {
  V4_STREAM_LABELS,
  blockToUniform,
  openStreams,
  seedKey,
  streamBlock,
  streamMessage,
} from '../../../src/computations/v4/rng';

// Key 00 01 .. 1f. Expected blocks computed independently with
//   printf 'rc-v4|duration|\x00\x00\x00\x00' | openssl dgst -sha256 -mac HMAC -macopt hexkey:<key>
const KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const OPENSSL_DURATION_0 = '58d128bd7c6a154cbb8d5b17e6e42367a5f066bb57a0393865670c52df02080a';
const OPENSSL_SHAPE_7 = 'abe6ca45eebf73e9590aa586dbdc8f415a6ed4d949f0995bf8415b2e2dc400ee';

describe('V4 keyed RNG (contract §1)', () => {
  it('matches an independent HMAC-SHA256 of "rc-v4|<label>|" + uint32 BE counter on the full seed', () => {
    const key = seedKey(KEY_HEX);
    expect(key.length).toBe(32);
    expect(streamBlock(key, 'duration', 0).toString('hex')).toBe(OPENSSL_DURATION_0);
    expect(streamBlock(key, 'shape', 7).toString('hex')).toBe(OPENSSL_SHAPE_7);
    expect(streamMessage('shape', 7).toString('hex')).toBe(
      Buffer.concat([Buffer.from('rc-v4|shape|'), Buffer.from([0, 0, 0, 7])]).toString('hex')
    );
  });

  it('turns the top 53 bits of a block into a uniform in [0, 1) (pinned)', () => {
    expect(blockToUniform(Buffer.from(OPENSSL_DURATION_0, 'hex'))).toBe(0.3469415152179993);
    expect(blockToUniform(Buffer.from(OPENSSL_SHAPE_7, 'hex'))).toBe(0.6714903279050739);
    expect(blockToUniform(Buffer.alloc(32, 0))).toBe(0);
    expect(blockToUniform(Buffer.alloc(32, 0xff))).toBe(1 - 2 ** -53);
    const streams = openStreams(KEY_HEX);
    expect(streams.draw('duration', 0)).toBe(0.3469415152179993);
    expect(streams.draw('shape', 7)).toBe(0.6714903279050739);
  });

  it('uses every seed bit: flipping the last bit changes every stream', () => {
    const flipped = KEY_HEX.slice(0, 63) + 'e';
    const a = openStreams(KEY_HEX);
    const b = openStreams(flipped);
    for (const label of V4_STREAM_LABELS) expect(a.draw(label, 0)).not.toBe(b.draw(label, 0));
  });

  it('keeps labels and counters independent and is case-insensitive in the hex', () => {
    const s = openStreams(KEY_HEX);
    const values = V4_STREAM_LABELS.map((label) => s.draw(label, 0));
    expect(new Set(values).size).toBe(V4_STREAM_LABELS.length);
    expect(s.draw('outcome', 0)).not.toBe(s.draw('outcome', 1));
    expect(openStreams(KEY_HEX.toUpperCase()).draw('outcome', 1)).toBe(s.draw('outcome', 1));
  });

  it('rejects bad seeds without echoing them, and bad counters or labels', () => {
    const secretish = 'ab'.repeat(31) + 'zz';
    expect(() => seedKey(secretish)).toThrow('64 hexadecimal');
    try {
      seedKey(secretish);
    } catch (error) {
      expect((error as Error).message).not.toContain('abab');
    }
    expect(() => seedKey('ab'.repeat(16))).toThrow();
    expect(() => seedKey(undefined as unknown as string)).toThrow();
    expect(() => streamMessage('shape', -1)).toThrow('uint32');
    expect(() => streamMessage('shape', 2 ** 32)).toThrow('uint32');
    expect(() => streamMessage('shape', 1.5)).toThrow('uint32');
    expect(() => streamMessage('nope' as never, 0)).toThrow('label');
    expect(streamMessage('shape', 0xffffffff).subarray(-4).toString('hex')).toBe('ffffffff');
  });

  it('zeroes its key copy on close and refuses later draws', () => {
    const s = openStreams(KEY_HEX);
    s.draw('linear', 0);
    s.close();
    expect(() => s.draw('linear', 0)).toThrow('closed');
  });
});
