// Seeded PRNG + corpus helpers for deterministic fuzzing (P8.2/P8.5).
// Fuzz runs must be REPRODUCIBLE: same seed → same corpus, failures replayable via
// FUZZ_SEED env (printed on every run). Determinism is enforced by construction.
export function makePrng(seed) {
  // mulberry32 — compact, stable across node versions
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seeded() {
  const s = Number.parseInt(process.env.FUZZ_SEED ?? "", 10);
  return Number.isFinite(s) ? s >>> 0 : 0x8a5ed;
}

export const ALPHABET = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  " ", "/", "\\", ".", "-", "_", "|", "&", ";", "<", ">", "`", "'", '"', "$", "*", "?", "~", "\n", "\t", "\r", "=", ":", "(", ")", "[", "]", "{", "}", "≠", "𝔲", "�",
];

export function randomString(prng, maxLen = 48) {
  const len = 1 + Math.floor(prng() * maxLen);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(prng() * ALPHABET.length)];
  return out;
}

export function randomBytesAsLatin(prng, len) {
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(Math.floor(prng() * 256));
  return out;
}

/** Determinism assertion helper — run fn twice, compare deep results. */
export function assertDeterministic(assert, fn, rounds = 25) {
  for (let i = 0; i < rounds; i++) {
    assert.deepEqual(fn(), fn(), `call #${i} not deterministic`);
  }
}
