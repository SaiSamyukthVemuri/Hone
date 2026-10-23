// Detection mechanics only: callers own detectors, tokenization, placeholders
// and failure policy. Unmatched original escapes are never decoded for output.
export type Detector = { re: RegExp; placeholder: string };

const MAX_DECODE_ROUNDS = 4;

/** One decoded character and the [start, end) range of the original token it
 *  decodes from. */
type Unit = { ch: string; start: number; end: number };

const isHex = (u: Unit | undefined): boolean => u !== undefined && /^[0-9a-f]$/i.test(u.ch);

/** One round of ASCII %XX decoding over units, left to right. Returns null
 *  when nothing changed. */
function decodeRound(units: Unit[]): Unit[] | null {
  const out: Unit[] = [];
  let changed = false;
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i]!;
    const h1 = units[i + 1];
    const h2 = units[i + 2];
    if (u.ch === "%" && isHex(h1) && isHex(h2)) {
      const code = parseInt(h1!.ch + h2!.ch, 16);
      if (code < 0x80) {
        out.push({ ch: String.fromCharCode(code), start: u.start, end: h2!.end });
        i += 2;
        changed = true;
        continue;
      }
    }
    out.push(u);
  }
  return changed ? out : null;
}

/** Replace every detector match found in the token's decoded form, at its
 *  original range. `undefined` means the token is still changing after the
 *  bound and must be dropped. */
export function replaceDecodedMatches(token: string, detectors: readonly Detector[]): string | undefined {
  // UTF-16 code units, not code points (Codex P2 4301959849 / 4301959252):
  // regex indexes and String.slice count code units, so an astral character
  // (an emoji is two units) must be two units here too.
  let units: Unit[] = Array.from({ length: token.length }, (_v, i) => ({ ch: token[i]!, start: i, end: i + 1 }));
  for (let round = 0; ; round += 1) {
    const next = decodeRound(units);
    if (next === null) break;
    if (round === MAX_DECODE_ROUNDS) return undefined;
    units = next;
  }
  const decoded = units.map((u) => u.ch).join("");
  const hits: Array<{ start: number; end: number; placeholder: string }> = [];
  for (const { re, placeholder } of detectors) {
    for (const m of decoded.matchAll(re)) {
      const first = units[m.index!]!;
      const last = units[m.index! + m[0].length - 1]!;
      hits.push({ start: first.start, end: last.end, placeholder });
    }
  }
  if (hits.length === 0) return token;
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let at = 0;
  for (const h of hits) {
    if (h.start < at) continue; // overlapped by an earlier (wider) hit
    out += token.slice(at, h.start) + h.placeholder;
    at = h.end;
  }
  return out + token.slice(at);
}
