// The canonical booking-request-key vectors, shared by every implementation of the rule (the TypeScript module now, the database check in the key change,
// and the other canonical retry-key rule when it lands, so equality with it is a single import and one loop). Each vector is one input and whether the
// rule accepts it. The rule: exactly 32 characters of 0-9 or a-f, an anchored match, REJECT never repair.

export type RequestKeyVector = { name: string; input: unknown; valid: boolean };

const HEX32 = "0123456789abcdef0123456789abcdef";

export const REQUEST_KEY_VECTORS: readonly RequestKeyVector[] = [
  { name: "32 lower-case hex characters", input: HEX32, valid: true },
  { name: "all zeros", input: "0".repeat(32), valid: true },
  { name: "all f", input: "f".repeat(32), valid: true },
  { name: "a real 128-bit value", input: "9f86d081884c7d659a2feaa0c55ad015", valid: true },

  { name: "upper case is rejected, not folded", input: HEX32.toUpperCase(), valid: false },
  { name: "one upper-case character", input: "A" + HEX32.slice(1), valid: false },
  { name: "31 characters", input: HEX32.slice(0, 31), valid: false },
  { name: "33 characters", input: HEX32 + "0", valid: false },
  { name: "empty string", input: "", valid: false },
  { name: "leading space is rejected, not trimmed", input: " " + HEX32, valid: false },
  { name: "trailing space is rejected, not trimmed", input: HEX32 + " ", valid: false },
  { name: "trailing newline is rejected (an unanchored `$` would let it through)", input: HEX32 + "\n", valid: false },
  { name: "leading newline", input: "\n" + HEX32, valid: false },
  { name: "embedded NUL", input: HEX32.slice(0, 16) + "\u0000" + HEX32.slice(17), valid: false },
  { name: "non-hex letter g", input: "g" + HEX32.slice(1), valid: false },
  { name: "a dashed UUID", input: "123e4567-e89b-12d3-a456-426614174000", valid: false },
  { name: "a UUID without dashes but 36 characters of padding", input: HEX32 + "0000", valid: false },
  { name: "full-width digits (a Unicode look-alike)", input: "０".repeat(32), valid: false },
  { name: "two keys joined", input: HEX32 + HEX32, valid: false },
  { name: "a number", input: 12345678901234567890123456789012, valid: false },
  { name: "null", input: null, valid: false },
  { name: "undefined", input: undefined, valid: false },
  { name: "an object that prints as a key", input: { toString: () => HEX32 }, valid: false },
  { name: "an array holding a key", input: [HEX32], valid: false },
];
