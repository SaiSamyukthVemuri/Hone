import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

// HON-48 / 0271: realtime.messages must never gain a way for a browser to publish.
//
// anon and authenticated hold INSERT on realtime.messages (hosted and local), so the table
// GRANT is not a barrier. The only barrier is RLS with no permissive INSERT or ALL policy.
// This pin therefore reads EVERY migration, present and future, and fails on any policy on
// realtime.messages that is not one of the two 0271 policies. Policies with no FOR clause are
// FOR ALL in SQL and count as INSERT. Quoting ("realtime"."messages") and a newline between
// ON and the table are matched. A future INSERT/ALL policy here is a RELEASE BLOCKER for the
// schedule signal: change this list only with Privacy and Insurance review.

const DIR = "supabase/migrations";
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

/** Line comments first, then block comments (a `*` inside a path must not open one). */
function strip(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const TABLE = String.raw`(?:"?realtime"?\s*\.\s*"?messages"?)`;
type Policy = { file: string; verb: string; name: string; body: string };

function policiesOnRealtimeMessages(): Policy[] {
  const out: Policy[] = [];
  const re = new RegExp(
    String.raw`\b(create|alter|drop)\s+policy\s+(?:if\s+(?:not\s+)?exists\s+)?("?[\w]+"?)\s+on\s+(?:only\s+)?${TABLE}([^;$]*)`,
    "gi",
  );
  for (const f of FILES) {
    const code = strip(readFileSync(`${DIR}/${f}`, "utf8"));
    for (const m of code.matchAll(re)) {
      out.push({ file: f, verb: m[1].toLowerCase(), name: m[2].replace(/"/g, ""), body: m[3].replace(/\s+/g, " ").trim() });
    }
  }
  return out;
}

const ALLOWED: Record<string, RegExp> = {
  schedule_signal_member_read: /^for select to authenticated using \(/i,
  schedule_signal_no_client_insert: /^as restrictive for insert to anon, authenticated with check \(false\)$/i,
};

describe("realtime.messages policies across every migration", () => {
  const found = policiesOnRealtimeMessages();

  it("finds 0271's two policies (so an empty scan cannot pass)", () => {
    const own = found.filter((p) => p.file.startsWith("0271_"));
    expect(own.map((p) => `${p.verb}:${p.name}`).sort()).toEqual([
      "create:schedule_signal_member_read",
      "create:schedule_signal_no_client_insert",
    ]);
  });

  it("every policy, in every migration, is create + one of the two allow-listed shapes", () => {
    const bad = found.filter((p) => p.verb !== "create" || !ALLOWED[p.name]?.test(p.body));
    expect(bad.map((p) => `${p.file}: ${p.verb} policy ${p.name} ${p.body.slice(0, 60)}`)).toEqual([]);
  });

  it("no migration other than 0271 creates a policy on realtime.messages", () => {
    expect(found.filter((p) => !p.file.startsWith("0271_")).map((p) => p.file)).toEqual([]);
  });

  it("no migration disables or forces RLS on, alters, or changes grants/ownership of realtime.messages", () => {
    const re = new RegExp(
      String.raw`(?:alter\s+table\s+(?:only\s+)?${TABLE}|(?:grant|revoke)\b[^;]*\bon\s+(?:table\s+)?${TABLE}|alter\s+(?:function|schema)\s+"?realtime\b)`,
      "i",
    );
    const bad = FILES.filter((f) => re.test(strip(readFileSync(`${DIR}/${f}`, "utf8"))));
    expect(bad).toEqual([]);
  });

  it("negative controls: the scanner sees an INSERT, an ALL-by-default, a quoted and a newline-split policy", () => {
    const sample = (sql: string) => {
      const re = new RegExp(String.raw`\bcreate\s+policy\s+("?[\w]+"?)\s+on\s+${TABLE}([^;$]*)`, "gi");
      return [...strip(sql).matchAll(re)].map((m) => ({ name: m[1], body: m[2].replace(/\s+/g, " ").trim() }));
    };
    expect(sample("create policy x on realtime.messages for insert to authenticated with check (true);")).toHaveLength(1);
    expect(sample("create policy x on realtime.messages using (true);")[0].body).toBe("using (true)");
    expect(sample('create policy x on "realtime"."messages" for all to anon using (true);')).toHaveLength(1);
    expect(sample("create policy x on\n  realtime.messages\n  for insert to anon with check (true);")).toHaveLength(1);
    expect(sample("-- create policy x on realtime.messages for insert;\n/* create policy y on realtime.messages */")).toHaveLength(0);
    // And the allow-list rejects them.
    expect(ALLOWED.schedule_signal_member_read.test("using (true)")).toBe(false);
    expect(ALLOWED.schedule_signal_no_client_insert.test("for insert to authenticated with check (true)")).toBe(false);
  });
});
