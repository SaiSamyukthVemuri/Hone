// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A: one coherent PrSnapshotKey per pass, and the confirming pass.
//
//   K0 = readKey()  ->  readBody(K0)  ->  K1 = readKey()
//
// A pass is coherent iff K1 == K0, structurally over all nine fields
// (PR-SNAPSHOT-01 §3), so a draft toggle, a head push, a retarget or a base
// advance all discard the pass. A first collection gets exactly one retry and a
// second move is `pr_key_moved` (§4). A read or parse failure ends the pass with
// that reason and is never retried. A terminal key reads nothing else (§7).
//
// The confirming pass (ARCH-01 §15) runs once, with no retry: a different key
// is `pr_key_moved`, never `unstable_snapshot`; equal keys with different
// non-key evidence is `unstable_snapshot`.
//
// Readers are injected. Anything a reader throws, and any result outside the
// closed shape, fails closed: nothing here can turn an exception into a key.
// ---------------------------------------------------------------------------

import { keysEqual } from "../../contract/pr-key.mjs";
import { isUnknownReason } from "../../contract/reasons.mjs";

const isTerminal = (key) => key.state !== "OPEN";

/** Call a reader; an exception or an out-of-contract result becomes a closed failure. */
function call(reader, ...args) {
  let r;
  try {
    r = reader(...args);
  } catch {
    return { ok: false, reason: "read_failed" };
  }
  if (r && r.ok === true) return r;
  if (r && r.ok === false && isUnknownReason(r.reason)) return { ok: false, reason: r.reason };
  return { ok: false, reason: "read_failed" };
}

function onePass({ readKey, readBody }) {
  const k0 = call(readKey);
  if (!k0.ok) return { kind: "failed", reason: k0.reason };

  let body = null;
  if (!isTerminal(k0.key)) {
    const b = call(readBody, k0.key);
    if (!b.ok) return { kind: "failed", reason: b.reason };
    body = b.value;
  }

  const k1 = call(readKey);
  if (!k1.ok) return { kind: "failed", reason: k1.reason };
  if (!keysEqual(k0.key, k1.key)) return { kind: "incoherent" };
  return { kind: "coherent", key: k0.key, body };
}

/**
 * One coherent collection: a pass, and at most one retry if the key moved.
 *
 * @returns {{ ok: true, key, body, attempts } | { ok: false, reason, attempts }}
 */
export function collectCoherent({ readKey, readBody }) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const p = onePass({ readKey, readBody });
    if (p.kind === "coherent") return { ok: true, key: p.key, body: p.body, attempts: attempt };
    if (p.kind === "failed") return { ok: false, reason: p.reason, attempts: attempt };
  }
  return { ok: false, reason: "pr_key_moved", attempts: 2 };
}

/**
 * The bounded full confirming pass: run once, compare with the first coherent pass.
 *
 * @param {{ first: { key, body }, readKey, readBody, sameEvidence: (a, b) => boolean }} args
 * @returns {{ ok: true } | { ok: false, reason }}
 */
export function confirmPass({ first, readKey, readBody, sameEvidence }) {
  const p = onePass({ readKey, readBody });
  if (p.kind === "failed") return { ok: false, reason: p.reason };
  if (p.kind === "incoherent") return { ok: false, reason: "pr_key_moved" };
  if (!keysEqual(first.key, p.key)) return { ok: false, reason: "pr_key_moved" };
  let same = false;
  try {
    same = sameEvidence(first.body, p.body) === true;
  } catch {
    same = false;
  }
  return same ? { ok: true } : { ok: false, reason: "unstable_snapshot" };
}
