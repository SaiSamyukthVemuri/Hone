import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Portal messages and replies. STATIC contract only: who writes the two tables in the
// application, that each writer resolves its actor and tenant from the session before it opens the service-role
// client, and the shape of the 0341 rollback. Runtime behaviour is in tests/db/portal-message-direct-writes.db.test.ts.

const root = join(__dirname, "..", "..");
const STAFF = "app/(app)/clients/[id]/portal-messages-actions.ts";
const PORTAL = "app/portal/portal-message-actions.ts";
const read = (f: string) => readFileSync(join(root, f), "utf8");
const exported = (f: string) =>
  read(f)
    .split(/\nexport async function /)
    .slice(1)
    .map((b) => ({ name: b.slice(0, b.indexOf("(")), body: b }));

describe("portal message writers: actor and tenant come from the session, never from the request", () => {
  it("the only application writers of the two tables are the staff and portal action files", () => {
    const files = execSync(`grep -rlE 'from\\("client_portal_message(s|_replies)"\\)' app lib || true`, { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((f) => /from\("client_portal_message(s|_replies)"\)[\s\S]{0,80}?\.(insert|update|upsert|delete)\(/.test(read(f)));
    expect(files.sort()).toEqual([STAFF, PORTAL].sort());
  });

  it("neither file writes through a user-scoped client, so the member write policies have no application caller", () => {
    for (const f of [STAFF, PORTAL]) {
      expect(read(f), f).not.toMatch(/\bcreateClient\(/);
      expect(read(f), f).toContain("createAdminClient(");
    }
  });

  it("every staff action resolves an ACTIVE practitioner and their studio before the service-role client, and scopes by that studio", () => {
    const actions = exported(STAFF);
    expect(actions.map((a) => a.name).sort()).toEqual(["archivePortalMessageAction", "createPortalMessageAction", "markPortalReplySeenAction"]);
    for (const { name, body } of actions) {
      const who = body.indexOf("await getCurrentPractitionerWithStudio()");
      const active = body.indexOf("if (!practitioner.active)");
      const admin = body.indexOf("createAdminClient(");
      expect(who, name).toBeGreaterThan(-1);
      expect(active, name).toBeGreaterThan(who);
      expect(admin, name).toBeGreaterThan(active);
      // tenant: the studio is the session's, never form data
      expect(body, name).not.toMatch(/formData[\s\S]{0,40}studio_id/);
      expect(body, name).toMatch(/studio_id: studio\.id|\.eq\("studio_id", studio\.id\)/);
    }
    const create = actions.find((a) => a.name === "createPortalMessageAction")!.body;
    expect(create).toContain("created_by_practitioner_id: practitioner.id"); // the sender is the caller
    expect(create).toMatch(/\.from\("clients"\)[\s\S]{0,200}\.eq\("studio_id", studio\.id\)/); // the client is in that studio
  });

  it("every portal action resolves the portal session before the service-role client, and scopes by its studio and client", () => {
    const actions = exported(PORTAL);
    expect(actions.map((a) => a.name).sort()).toEqual(["createPortalMessageReplyAction", "markPortalMessageReviewedAction"]);
    for (const { name, body } of actions) {
      const who = body.indexOf("await getCurrentPortalSession()");
      const admin = body.indexOf("createAdminClient(");
      expect(who, name).toBeGreaterThan(-1);
      expect(admin, name).toBeGreaterThan(who);
      expect(body, name).toContain('.eq("studio_id", session.studioId)');
      expect(body, name).toContain('.eq("client_id", session.clientId)');
    }
    const reply = actions.find((a) => a.name === "createPortalMessageReplyAction")!.body;
    expect(reply).toMatch(/studio_id: session\.studioId,\s+client_id: session\.clientId/);
  });
});

describe("0341 rollback: restores exactly what the migration removed", () => {
  const NAME = "0341_portal_message_member_write_policies";
  const strip = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  const DOWN = strip(read(`supabase/rollbacks/${NAME}.down.sql`));
  const TABLES = ["client_portal_messages", "client_portal_message_replies"];
  const WRITE_POLICIES = [
    ["client_portal_messages_studio_member_insert", "client_portal_messages"],
    ["client_portal_messages_studio_member_update", "client_portal_messages"],
    ["client_portal_message_replies_studio_member_update", "client_portal_message_replies"],
  ] as const;
  // every "public.<table>" either file names must be one of the two
  const tablesNamed = (sql: string) => [...new Set([...sql.matchAll(/\bon (?:table )?public\.([a-z_]+)/g)].map((m) => m[1]))].sort();

  it("the rollback grants back exactly what was revoked and restores the three 0055 policy definitions", () => {
    expect(DOWN.match(/grant [^;]+;/g) ?? []).toEqual(
      TABLES.map((t) => `grant insert, update on table public.${t} to anon, authenticated;`),
    );
    expect(DOWN).not.toMatch(/\bpublic\b(?!\.)|service_role|\ball\b|\b(insert into|update public|delete from)\b/); // nothing to PUBLIC, nothing broader
    expect(tablesNamed(DOWN)).toEqual([...TABLES].sort());
    // each restored policy is, statement for statement, the 0055 definition
    const original = strip(read("supabase/migrations/0055_client_portal_message_rls_policies.sql"));
    const norm = (x: string) => x.replace(/\s+/g, " ").trim();
    const def = (sql: string, policy: string) => norm(sql.match(new RegExp(`create policy "${policy}"[^;]+;`))?.[0] ?? `missing ${policy}`);
    expect(DOWN.match(/create policy/g)?.length).toBe(3);
    for (const [policy] of WRITE_POLICIES) {
      expect(def(DOWN, policy)).toBe(def(original, policy));
    }
  });
});
