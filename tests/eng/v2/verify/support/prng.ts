// Independent verifier support: a seeded PRNG.
//
// xoshiro128** seeded through splitmix32. Deliberately a different generator
// from the builder's harness, so the two corpora do not share a sequence.

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export interface Rng {
  /** uniform in [0, 1) */
  next(): number;
  /** uniform integer in [0, n) */
  int(n: number): number;
  bool(p?: number): boolean;
  pick<T>(xs: readonly T[]): T;
  shuffle<T>(xs: readonly T[]): T[];
  hex(len: number): string;
}

export function rng(seed: number): Rng {
  const sm = splitmix32(seed);
  const s = [sm(), sm(), sm(), sm()];
  const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
  const u32 = () => {
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  };
  const next = () => u32() / 4294967296;
  const int = (n: number) => Math.floor(next() * n);
  return {
    next,
    int,
    bool: (p = 0.5) => next() < p,
    pick: (xs) => xs[int(xs.length)],
    shuffle: (xs) => {
      const a = [...xs];
      for (let i = a.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    hex: (len) => {
      let out = "";
      for (let i = 0; i < len; i++) out += "0123456789abcdef"[int(16)];
      return out;
    },
  };
}
