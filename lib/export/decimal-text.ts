/**
 * Exact decimal text for an export column. A PostgreSQL numeric has no fixed precision, so it must never pass through a JavaScript number
 * (9007199254740993 would become 9007199254740992). The caller reads the column as text (`col::text`) and this pads the fraction with zeros up
 * to the contract's decimals. Digits are never rounded or dropped: a value with more fractional digits than `decimals` keeps them all.
 * Anything that is not plain decimal text is returned unchanged rather than guessed at.
 */
const PLAIN_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

export function padDecimalText(value: string | null | undefined, decimals: number | null | undefined): string | null {
  if (value == null) return null;
  const m = PLAIN_DECIMAL.exec(value.trim());
  if (!m) return value;
  const want = Number.isInteger(decimals) && (decimals as number) > 0 ? (decimals as number) : 0;
  const frac = m[3] ?? "";
  const padded = frac.length >= want ? frac : frac + "0".repeat(want - frac.length);
  return padded === "" ? `${m[1]}${m[2]}` : `${m[1]}${m[2]}.${padded}`;
}
