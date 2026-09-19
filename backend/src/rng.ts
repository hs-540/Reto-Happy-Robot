/**
 * Deterministic pseudo-random generator (mulberry32). Every draw of the
 * scenario must be reproducible from its seed alone: same seed, same crisis.
 */
export interface Rng {
  /** Uniform in [0, 1) */
  next(): number;
  /** Uniform integer in [min, max], both inclusive */
  int(min: number, max: number): number;
  /** Uniform element of a non-empty array */
  pick<T>(items: readonly T[]): T;
  /** Fisher-Yates copy; the input is left untouched */
  shuffle<T>(items: readonly T[]): T[];
  /** True with probability p */
  chance(p: number): boolean;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    int(min: number, max: number): number {
      return min + Math.floor(next() * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error("cannot pick from an empty list");
      return items[Math.floor(next() * items.length)];
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    chance(p: number): boolean {
      return next() < p;
    },
  };
}

/** Seed for the retry chain: deterministic given the base seed and the attempt */
export function deriveSeed(base: number, attempt: number): number {
  return (Math.imul(base ^ (attempt + 1), 0x9e3779b1) + attempt) >>> 0;
}
