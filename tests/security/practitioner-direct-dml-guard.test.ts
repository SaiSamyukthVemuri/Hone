import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// PRACTITIONER DIRECT-DML GUARD (audit finding A-P1-01, migration 0178).
// ===========================================================================
//
// WHY THIS EXISTS. 0178 revoked INSERT/UPDATE/DELETE on `public.practitioners`
// from `anon` and `authenticated`, so a browser-client write now fails at the
// privilege layer. That is the real enforcement, and this guard cannot
// substitute for it.
//
// What this guard catches is the SLOW regression: someone reintroduces
// `.from("practitioners").update(...)` on the authenticated client, it silently
// fails in production for every practitioner, and nobody notices until a
// support ticket — because a PostgREST privilege error surfaces as a generic
// "Failed to save" toast. Failing at CI time is much cheaper.
//
// It also freezes the SERVICE-ROLE writers. Each exception below is named
// individually with its authorization chain; the allowlist is deliberately
// per-writer and never per-directory, because "everything under app/admin is
// fine" is how an unreviewed write gets in.

const ROOT = join(__dirname, "..", "..");
const ROOTS = ["app", "lib", "components", "scripts"];

/**
 * Every service-role practitioner writer that is allowed to exist.
 *
 * Adding an entry is a review decision: state the file, the function, why the
 * service role is genuinely required, and what authorization happens BEFORE the
 * write. An entry without those four facts is not reviewable.
 */
const SERVICE_ROLE_ALLOWLIST: ReadonlyArray<{
  file: string;
  writer: string;
  whyServiceRole: string;
  authorizationBeforeWrite: string;
}> = [
  {
    file: "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
    writer: "rememberMachineFrequencyDefault",
    whyServiceRole:
      "Writes ONLY practitioners.default_machine_frequency — a UI convenience default, " +
      "not an identity or roster field. It runs as a fire-and-forget tail of a charting " +
      "save, and 0178 removed the authenticated privilege it previously relied on.",
    authorizationBeforeWrite:
      "The enclosing charting action has already resolved the acting practitioner through " +
      "getCurrentPractitionerWithStudio() and written the session block; the practitioner id " +
      "is server-resolved, never taken from the request payload.",
  },
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
    }
  };
  for (const r of ROOTS) walk(r);
  return out;
}

type Site = { file: string; line: number; verb: string; admin: boolean };

/**
 * Every `.from("practitioners")` chain that reaches a write verb.
 *
 * The chain is walked with brace/paren depth tracking rather than a fixed
 * lookahead, so a write far below the `.from()` is still seen. Whether the
 * chain is a service-role one is decided by the RECEIVER, so
 * `const admin = createAdminClient(); admin.from(...)` is classified correctly
 * even when the factory call is far above.
 */
function practitionerWriteSites(): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(join(ROOT, file), "utf8");
    // Receiver names bound to an admin/service-role client anywhere in the file.
    const adminReceivers = new Set(
      [...src.matchAll(/(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(?:await\s+)?createAdminClient\(/g)].map(
        (m) => m[1],
      ),
    );
    const re = /(\w+)?\s*\.?\s*from\(\s*["']practitioners["']\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      // Walk the statement to its terminating `;` at depth 0.
      let i = m.index + m[0].length;
      let depth = 0;
      let chain = "";
      while (i < src.length) {
        const ch = src[i];
        if ("([{".includes(ch)) depth++;
        else if (")]}".includes(ch)) depth--;
        else if (ch === ";" && depth <= 0) break;
        chain += ch;
        i++;
      }
      const verb = /\.(insert|update|delete|upsert)\s*\(/.exec(chain)?.[1];
      if (!verb) continue;
      const line = src.slice(0, m.index).split("\n").length;
      const receiver = m[1];
      const isAdmin =
        (receiver != null && adminReceivers.has(receiver)) ||
        // `createAdminClient().from("practitioners")` with no intermediate name.
        src.slice(Math.max(0, m.index - 80), m.index).includes("createAdminClient()");
      sites.push({ file, line, verb, admin: isAdmin });
    }
  }
  return sites;
}

const SITES = practitionerWriteSites();

describe("practitioners direct-DML guard — the analyzer is alive", () => {
  it("walks a real tree", () => {
    const files = sourceFiles();
    expect(files.length, "an empty file list would make every assertion vacuous").toBeGreaterThan(
      200,
    );
  });

  it("finds the practitioners table at all (read or write)", () => {
    const anyRef = sourceFiles().some((f) =>
      readFileSync(join(ROOT, f), "utf8").includes('from("practitioners")'),
    );
    expect(anyRef, "the analyzer must be able to see this table").toBe(true);
  });
});

describe("no AUTHENTICATED-client write may reach public.practitioners", () => {
  it("every practitioner write site is a reviewed service-role writer", () => {
    const browserWrites = SITES.filter((s) => !s.admin);
    expect(
      browserWrites.map((s) => `${s.file}:${s.line} .${s.verb}()`),
      "0178 revoked INSERT/UPDATE/DELETE from `authenticated`, so a browser-client " +
        "write here fails at runtime for every practitioner. Use a narrow " +
        "self-service command (see 0178) or a reviewed service-role writer.",
    ).toEqual([]);
  });

  it("the service-role writers are exactly the allowlisted ones", () => {
    const adminFiles = [...new Set(SITES.filter((s) => s.admin).map((s) => s.file))].sort();
    expect(adminFiles).toEqual([...SERVICE_ROLE_ALLOWLIST.map((a) => a.file)].sort());
  });

  it("every allowlist entry documents its authorization chain", () => {
    for (const entry of SERVICE_ROLE_ALLOWLIST) {
      expect(entry.writer.length, entry.file).toBeGreaterThan(0);
      expect(entry.whyServiceRole.length, entry.file).toBeGreaterThan(60);
      expect(entry.authorizationBeforeWrite.length, entry.file).toBeGreaterThan(60);
      // The named writer must actually exist in the named file.
      const src = readFileSync(join(ROOT, entry.file), "utf8");
      expect(src, `${entry.file} must contain ${entry.writer}`).toContain(entry.writer);
    }
  });

  it("the allowlist is per-writer, never per-directory", () => {
    for (const entry of SERVICE_ROLE_ALLOWLIST) {
      expect(entry.file, "an allowlist entry must be an exact file").toMatch(/\.tsx?$/);
      expect(entry.file).not.toMatch(/\*/);
    }
  });
});

describe("the profile self-service path goes through the command boundary", () => {
  const PROFILE = "app/(app)/settings/profile/actions.ts";
  const src = readFileSync(join(ROOT, PROFILE), "utf8");

  it("issues NO direct table write", () => {
    expect(src).not.toMatch(/\.from\(\s*["']practitioners["']\s*\)/);
  });

  it("calls each of the four narrow commands exactly once", () => {
    for (const fn of [
      "set_own_practitioner_display_name",
      "set_own_practitioner_color",
      "rotate_own_calendar_feed_token",
      "clear_own_calendar_feed_token",
    ]) {
      expect((src.match(new RegExp(`rpc\\("${fn}"`, "g")) ?? []).length, fn).toBe(1);
    }
  });

  it("uses the AUTHENTICATED client — never the admin client", () => {
    // The whole point of a self-service command is that it runs as the caller,
    // so auth.uid() identifies them. An admin client would have a NULL uid and
    // would also reintroduce an unaudited privileged path.
    expect(src).toContain("createClient()");
    expect(src).not.toContain("createAdminClient");
  });

  it("never sends an identity field to the command", () => {
    // CODE only. Prose that legitimately NAMES a field ("the command proves
    // user_id = auth.uid()") must not satisfy a guard looking for that field
    // being sent.
    const code = src
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    for (const forbidden of ["user_id", "studio_id", "p_role", "p_active", '"role"', "active:"]) {
      expect(code, `profile actions must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("keeps the product validation in front of the command", () => {
    expect(src, "blank display names stay rejected").toMatch(/trimmedOrThrow/);
    expect(src, "the palette gate stays authoritative in TypeScript").toMatch(
      /isPractitionerColor/,
    );
    expect(src, "the raw token is hashed before it leaves the server").toMatch(
      /hashCalendarFeedToken/,
    );
  });

  it("still revalidates every surface it did before", () => {
    for (const path of [
      "/settings/profile",
      "/settings/studio",
      "/settings/team",
      "/dashboard",
      "/calendar",
    ]) {
      expect(src, `revalidatePath("${path}") must survive`).toContain(`revalidatePath("${path}")`);
    }
  });
});

describe("the governed roster path is untouched", () => {
  it("team administration still goes through set_practitioner_active_locked", () => {
    const team = readFileSync(join(ROOT, "app/(app)/settings/team/actions.ts"), "utf8");
    expect(team).toContain("set_practitioner_active_locked");
    expect(team, "and still through the admin client").toContain("createAdminClient");
  });

  it("no new generic practitioner-patch RPC was introduced anywhere", () => {
    for (const file of sourceFiles()) {
      const src = readFileSync(join(ROOT, file), "utf8");
      for (const banned of [
        'rpc("update_practitioner"',
        'rpc("patch_practitioner"',
        'rpc("update_practitioner_field"',
        'rpc("set_practitioner_column"',
      ]) {
        expect(src, `${file} must not call ${banned}`).not.toContain(banned);
      }
    }
  });
});
