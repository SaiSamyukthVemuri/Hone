/**
 * The truth register's PROVENANCE and its RULES — no JSX, no interpretation.
 *
 * WHY THIS MODULE EXISTS, AND WHY IT IS ONLY THIS
 * -----------------------------------------------
 * Its predecessor tried to answer two different questions with one mechanism:
 * "has the evidence this register cites moved?" and "what sentence does this
 * React tree render?". The first is a git question and is settled. The second
 * is program interpretation, and nine consecutive review rounds showed it has no
 * natural edge — each fix bought one more TypeScript construct and opened the
 * next gap. See `MARKETING_SCANNER_ARCH_DECISION_2026-09-20.md`.
 *
 * The owner ruling split them. This module keeps the settled half verbatim:
 *
 *   - the public route set, read from the MARKETING_PAGES registry;
 *   - the rules, parsed out of the register itself so a ruling and its
 *     enforcement cannot be two documents that disagree;
 *   - the cited-evidence extraction and `--no-renames` movement detection that
 *     make staleness a test failure;
 *   - the §0.4 append-only judgement, which operates on a COMPLETE sentence.
 *
 * What a visitor actually reads is now answered by `copy-sources.ts`, which does
 * not interpret a program: the authoring law requires complete static copy, and
 * that guard REFUSES what it cannot read instead of inferring it.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { MARKETING_PAGES } from "@/lib/marketing/content";

export const REPO_ROOT = resolve(__dirname, "../../..");

export const readSource = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// 1. The surface: which files a visitor's page is built from
// ---------------------------------------------------------------------------

/**
 * The route file behind each indexable public path.
 *
 * `MARKETING_PAGES` is the registry of record for what is public — it drives
 * `SITEMAP_PATHS`, the per-page metadata and the middleware allowlist — so
 * deriving from it means a new indexable route cannot be added without this
 * scan picking it up. `/privacy` and `/terms` are ordinary members here; they
 * were previously filtered out, which is precisely how the whole of both policy
 * texts went unscanned.
 */
export function publicRouteFiles(): string[] {
  return MARKETING_PAGES.filter((p) => p.indexable).map((p) => {
    const rel =
      p.path === "/" ? "app/page.tsx" : `app${p.path}/page.tsx`;
    if (!existsSync(join(REPO_ROOT, rel))) {
      throw new Error(
        `MARKETING_PAGES declares ${p.path} indexable, but ${rel} does not exist — ` +
          "the public-copy scan cannot open the page it is supposed to govern",
      );
    }
    return rel;
  });
}

// ---------------------------------------------------------------------------
// 2. Text normalisation, shared by the rules and by copy-sources.ts
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  "&apos;": "'",
  "&quot;": '"',
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&middot;": "·",
  "&times;": "×",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m) => {
    const named = NAMED_ENTITIES[m.toLowerCase()];
    if (named) return named;
    const dec = /^&#(\d+);$/.exec(m);
    if (dec) return String.fromCodePoint(Number(dec[1]));
    const hex = /^&#x([0-9a-fA-F]+);$/i.exec(m);
    if (hex) return String.fromCodePoint(parseInt(hex[1], 16));
    return m;
  });
}

export const normalise = (text: string) => decodeEntities(text).replace(/\s+/g, " ").trim();

/**
 * Fold every dash a browser renders as a hyphen down to an ASCII one, for
 * MATCHING only — the claim text itself keeps what the author wrote.
 *
 * `append‑only` with U+2011 (or its `&#8209;` entity, which decodes to the same
 * character) reads identically to a visitor and was invisible to an ASCII-only
 * pattern, so an unsupported sentence slipped past both the sanctioned-wording
 * allow-list and the forbidden patterns. Non-breaking and thin spaces fold too:
 * `\s` already covers U+00A0, but U+2009 and friends are not whitespace to
 * every engine and would have split a word the same way.
 */
export const foldForMatching = (text: string) =>
  text
    // U+2010 hyphen through U+2015 horizontal bar, U+2212 minus, and the
    // small/fullwidth forms. All render as a hyphen.
    .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, "-")
    // U+00A0 no-break space, U+2000-U+200A, U+202F, U+205F, U+3000.
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// ---------------------------------------------------------------------------
// 3. The rules: parsed FROM the register, not kept in parallel with it
// ---------------------------------------------------------------------------

export type ForbiddenWording = {
  readonly id: string;
  readonly source: string;
  readonly pattern: RegExp;
};

/**
 * The wordings §0.4 forbids, read out of the register itself.
 *
 * Review's objection to the earlier version was exact and correct: the guard
 * hard-coded a list of patterns, claimed to enforce §0.4, and did not match the
 * canonical sentence §0.4 actually rejects — so the register's own rejected
 * wording could have shipped green. A ruling and its enforcement cannot be two
 * documents. The register now carries a fenced `forbidden-public-wording`
 * block, and this is the only place the guard learns what is banned.
 */
export function forbiddenWordings(register: string): ForbiddenWording[] {
  const block = /```forbidden-public-wording\n([\s\S]*?)```/.exec(register);
  if (!block) {
    throw new Error(
      "the truth register carries no machine-readable `forbidden-public-wording` " +
        "block; §0.4's ruling would not be enforced by anything",
    );
  }
  const rules: ForbiddenWording[] = [];
  for (const raw of block[1].split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const split = line.indexOf("|");
    if (split < 0) {
      throw new Error(
        `malformed forbidden-wording rule (expected "<id> | <regex>"): ${line}`,
      );
    }
    const id = line.slice(0, split).trim();
    const source = line.slice(split + 1).trim();
    if (!id || !source) {
      throw new Error(`malformed forbidden-wording rule: ${line}`);
    }
    rules.push({ id, source, pattern: new RegExp(source, "i") });
  }
  if (rules.length === 0) {
    throw new Error("the forbidden-public-wording block declares no rules");
  }
  return rules;
}

/**
 * Every repository file §0 cites as evidence for a classification.
 *
 * Taken from the register's own backticked citations rather than a second list,
 * so a row that starts resting on a new file starts watching that file. These
 * are what "production has advanced and nothing this register rests on moved"
 * is a claim ABOUT — without them the staleness row is a date, not a check.
 */
export function citedEvidenceFiles(register: string): string[] {
  const operative = register.slice(
    register.indexOf("## 0. v2.2 copy-deck claim classification"),
  );
  const out = new Set<string>();
  for (const m of operative.matchAll(/`([^`\n]+)`/g)) {
    // Citations wrap lines in the source table, so a path can arrive with a
    // newline inside it; the register also cites directory globs.
    const token = m[1].replace(/\s+/g, "");
    const glob = token.endsWith("/**");
    const candidate = (glob ? token.slice(0, -3) : token)
      .replace(/[:#].*$/, "")
      .replace(/\/{2,}/g, "/")
      .replace(/\/$/, "");
    if (!/^[\w./@()[\]-]+$/.test(candidate)) continue;

    // EXISTENCE IS NOT THE TEST. Filtering citations through the working tree
    // dropped exactly the change the staleness check must catch: when
    // production deletes or renames a cited file, it is absent from a branch
    // carrying that change, so the old path fell out of the watch set and the
    // deletion `git diff` reports could never match anything. A citation is
    // therefore classified by SHAPE — a known source extension makes it a file,
    // whatever the working tree currently holds.
    //
    // Shape is how a DELETED path stays watched, and it cannot lean on an
    // extension list. §0's V13 row cites `.env.local.example`; a list of known
    // extensions drops it, and falling back to "does it exist" drops it again
    // the moment production deletes it — which is exactly the change the
    // comparison must report. So a FILE is recognised by the shape of its last
    // segment: a dotted name. That covers `expiry.ts`, `package.json` and
    // `.env.local.example` alike, and it survives deletion.
    //
    // The qualifier keeps §0's prose out. A dotted token with no path around it
    // could equally be a version or a measurement — `v2.2`, `13.56` — so a bare
    // dotted name counts only when it is a dotfile or actually exists.
    const isDir = isDirectory(candidate);
    const exists = existsSync(join(REPO_ROOT, candidate));
    const lastSegment = candidate.split("/").pop() ?? "";
    // A leading dot is enough on its own — `.env`, `.npmrc`, `.gitignore` are
    // whole filenames. Without the first alternative the optional dot was
    // consumed and a SECOND component was then required, so an ordinary dotfile
    // failed the shape test and a deleted one fell out of the watch set again.
    // Anything else needs a dot INSIDE it to count as a filename.
    const dotted = /^(?:\.[\w-]+(?:\.[\w-]+)*|[\w-]+(?:\.[\w-]+)+)$/.test(lastSegment);
    const looksLikeFile =
      dotted &&
      (candidate.includes("/") || lastSegment.startsWith(".") || (exists && !isDir));

    if (!glob && !looksLikeFile && !isDir) continue;

    if (glob || (!looksLikeFile && isDir)) {
      // A bare top-level directory is prose, not evidence. §0 says things like
      // "zero calls to billingPortal across `app/` + `lib/`" — treating that as
      // a watch root would red on essentially every production merge, which is
      // the failure this guard was built to avoid. A citation has to name
      // something narrower than a whole tree to count as evidence for a row.
      if (!candidate.includes("/")) continue;
      // Trailing slash marks a prefix match: `git diff --name-only` returns
      // `lib/record-keeping/expiry.ts`, never the bare directory, so reducing
      // `lib/record-keeping/**` to `lib/record-keeping` and comparing for
      // equality watched nothing at all.
      out.add(`${candidate}/`);
      continue;
    }
    out.add(candidate);
  }
  return [...out].sort();
}

const isDirectory = (rel: string): boolean => {
  try {
    return statSync(join(REPO_ROOT, rel)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Does a changed path fall under anything watched?
 *
 * Entries ending in `/` are directories and match by prefix; everything else is
 * an exact file. Equality alone silently watched no directory citation.
 */
export function isWatched(path: string, watched: Iterable<string>): boolean {
  for (const w of watched) {
    if (w.endsWith("/") ? path.startsWith(w) : path === w) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 4. The scoped-claim ruling (§0.4 N1)
// ---------------------------------------------------------------------------

/**
 * §0.4 N1. Migration 0086's trigger-written trail covers sterile items,
 * disinfectants, exposure incidents, the aftercare mark and
 * `session_blocks.probe_lot_number` — THAT COLUMN ONLY. Every other charted
 * value is a plain UPDATE through `update_block_with_entry` (0166) that keeps
 * no prior value.
 *
 * WHY THIS IS AN ALLOW-LIST
 * -------------------------
 * It was a deny-list: name a supported record type, and avoid an enumerated set
 * of widening terms. Review broke it with a conjunction — *"Energy settings and
 * sterile items have an append-only edit history"* passes, because `sterile
 * items` satisfies the scope and neither `energy` nor `settings` is in the
 * widening list, while energy edits keep no prior value at all. That is not a
 * missing term. No enumeration of the unsupported nouns can be complete, because
 * the unsupported set is every charted field the product has or will have.
 *
 * So the question is inverted: public copy may make an append-only claim only in
 * a wording §0.4 has sanctioned, and the sanctioned wordings live in the
 * register. Anything else is rejected whatever it says. That is deliberately
 * brittle — rephrasing a claim about what is audited SHOULD require going back
 * to the authority that classified it, which is the whole premise of §0.
 *
 * The two patterns below no longer gate public copy. They gate the ALLOW-LIST:
 * a sanctioned wording must still name a covered record type and must not
 * contain an obvious widening. They catch a careless register entry, not a
 * clever one — the register is a human ruling, and this cannot check the
 * classification, only its shape.
 */
export const SUPPORTED_APPEND_ONLY_SCOPE =
  /\b(sterile[- ]item|sterile items|disinfectant|exposure incident|probe lot|lot number|record[- ]keeping)\b/i;

export const APPEND_ONLY_OVERREACH =
  /\b(every (record|change|edit|treatment|field)|all (records|changes|edits|treatments)|treatment record|charting|chart(ed)? (value|field)|session|clinical)\b/i;

/** "append-only" and "append only" are the same promise to a reader. */
export const APPEND_ONLY_TRIGGER = /append[-\s]only/i;

export type SanctionedWording = { readonly id: string; readonly text: string };

/**
 * The append-only wordings §0.4 sanctions, read out of the register.
 *
 * Literal sentences, not patterns: a pattern would reintroduce exactly the
 * looseness this replaces.
 */
export function sanctionedAppendOnlyWordings(register: string): SanctionedWording[] {
  const block = /```supportable-append-only-wording\n([\s\S]*?)```/.exec(register);
  if (!block) {
    throw new Error(
      "the truth register carries no machine-readable " +
        "`supportable-append-only-wording` block; every append-only claim would " +
        "be rejected and §0.4's supportable form could not ship",
    );
  }
  const out: SanctionedWording[] = [];
  for (const raw of block[1].split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const split = line.indexOf("|");
    if (split < 0) {
      throw new Error(
        `malformed sanctioned-wording entry (expected "<id> | <sentence>"): ${line}`,
      );
    }
    const id = line.slice(0, split).trim();
    const text = normalise(line.slice(split + 1));
    if (!id || !text) throw new Error(`malformed sanctioned-wording entry: ${line}`);
    out.push({ id, text });
  }
  if (out.length === 0) {
    throw new Error("the supportable-append-only-wording block sanctions nothing");
  }
  return out;
}

export type AppendOnlyVerdict =
  | { readonly kind: "not-a-claim" }
  | { readonly kind: "sanctioned"; readonly id: string }
  | { readonly kind: "unsanctioned" };

export function judgeAppendOnlyClaim(
  claim: string,
  sanctioned: readonly SanctionedWording[],
): AppendOnlyVerdict {
  // Folded on both sides: `append‑only` with a non-breaking hyphen is the same
  // promise to a reader, and used to be classified `not-a-claim` — which sent
  // it past the allow-list AND past the forbidden patterns.
  const folded = foldForMatching(normalise(claim));
  if (!APPEND_ONLY_TRIGGER.test(folded)) return { kind: "not-a-claim" };
  const hit = sanctioned.find((s) => foldForMatching(s.text) === folded);
  return hit ? { kind: "sanctioned", id: hit.id } : { kind: "unsanctioned" };
}
