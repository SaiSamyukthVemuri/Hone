// ---------------------------------------------------------------------------
// Shared vocabulary for the canonical-production-doc guards.
//
// These are pure text predicates with no assertions of their own, so more than
// one test file can agree on what "a current-state assertion" means. The rules
// themselves live in tests/docs/canonical-production-facts.test.ts; this module
// exists so tests/docs/clinical-finalization-retired.test.ts can share the
// definition of CURRENT prose rather than growing a second, subtly different
// one. Two guards disagreeing about which text is current is how the drift
// this whole change exists to fix got started.
// ---------------------------------------------------------------------------

/**
 * Explicitly-marked frozen regions.
 *
 * A canonical document may quote a claim it is correcting — that is how a
 * correction stays auditable instead of silently overwriting history. Such a
 * quotation is wrapped in:
 *
 *   <!-- canonical-facts:ignore-start reason=why-this-is-historical -->
 *   …superseded text, preserved verbatim…
 *   <!-- canonical-facts:ignore-end -->
 *
 * The marker is deliberate, greppable and reviewable. Heuristics ("is this in
 * a blockquote?", "does it say 'previously'?") were rejected: a guard whose
 * exemptions are guessed cannot be reasoned about.
 */
export const IGNORE_BLOCK =
  /<!--\s*canonical-facts:ignore-start([^>]*)-->[\s\S]*?<!--\s*canonical-facts:ignore-end\s*-->/g;

/** Strip explicitly-marked historical regions. Everything left is CURRENT. */
export function currentProse(doc: string): string {
  return doc.replace(IGNORE_BLOCK, "\n");
}

/** Every ignore marker in a document, with whatever reason it declared. */
export function ignoreMarkers(doc: string): string[] {
  return [...doc.matchAll(IGNORE_BLOCK)].map((m) => m[1].trim());
}

/** Run a set of global patterns over text, returning normalised match text. */
export function matchAll(text: string, patterns: readonly RegExp[]): string[] {
  const hits: string[] = [];
  for (const re of patterns) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      hits.push(m[0].replace(/\s+/g, " ").trim());
    }
  }
  return hits;
}
