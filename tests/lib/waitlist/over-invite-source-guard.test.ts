import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");
/** Code only: comments may name what the file does NOT do. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const FILES = [
  "lib/waitlist/over-invite-port.ts",
  "lib/waitlist/over-invite-worker.ts",
  "lib/waitlist/over-invite-deliver.ts",
  "lib/waitlist/over-invite-result.ts",
  "app/(app)/settings/waitlist/over-invite/actions.ts",
  "app/(app)/settings/waitlist/over-invite/page.tsx",
  "components/waitlist/over-invite-form.tsx",
];

describe("over-invite source guards", () => {
  it("no file on the over-invite route can send an SMS (items 26-30)", () => {
    for (const f of FILES) expect(code(f), f).not.toMatch(/sendWaitlistInvitationSms|delivery\/sms|twilio|\bsms\b/i);
  });
  it("delivery uses the SAME function today's single invite uses, not a copy (OPS email-eligibility rule)", () => {
    const adapter = read("lib/waitlist/invite-to-book-adapter.ts");
    const deliver = read("lib/waitlist/over-invite-deliver.ts");
    expect(adapter).toMatch(/export async function deliverInvitation\(/);
    expect(adapter).toMatch(/await deliverInvitation\(\{/);
    expect(deliver).toMatch(/import \{[^}]*deliverInvitation[^}]*\} from "@\/lib\/waitlist\/invite-to-book-adapter"/);
    expect(deliver).not.toMatch(/sendWaitlistInvitationEmail/);
    // And both go through the one database admit command.
    expect(adapter).toMatch(/"admit_new_client_waitlist_entry"/);
    expect(read("lib/waitlist/over-invite-port.ts")).toMatch(/"admit_new_client_waitlist_entry"/);
  });
  it("no production caller of claim_waitlist_batch_items passes a time (item 24)", () => {
    const port = read("lib/waitlist/over-invite-port.ts");
    const call = port.slice(port.indexOf('rpc("claim_waitlist_batch_items"'));
    const args = call.slice(0, call.indexOf("});"));
    expect(args).not.toMatch(/p_now|p_at|p_time|p_claimed_at|new Date|Date\.now/);
  });
  it("nothing on the route logs (items 4, 22)", () => {
    for (const f of FILES) expect(code(f), f).not.toMatch(/console\.(log|error|warn|info)|recordOpsAlert|Sentry/);
  });
  it("the page passes the chooser names only, never an email (item 16)", () => {
    const page = read("app/(app)/settings/waitlist/over-invite/page.tsx");
    expect(page).toMatch(/\.select\("id,name"\)/);
    expect(code("app/(app)/settings/waitlist/over-invite/page.tsx")).not.toMatch(/email|phone/i);
  });
  it("the form posts every selected id exactly once and the chooser is the only entryId source (item 20)", () => {
    expect(read("components/waitlist/over-invite-form.tsx")).not.toMatch(/name="entryId"/);
    expect(read("components/waitlist/over-invite-confirm.tsx")).not.toMatch(/name="entryId"/);
    expect(read("components/waitlist/recipient-chooser.tsx").match(/name="entryId"/g)?.length).toBe(1);
  });
  it("the batch key is a random uuid, not derived from any id (item 2)", () => {
    const sel = read("lib/waitlist/over-invite-selection.ts");
    expect(sel).toMatch(/return randomUUID\(\)/);
  });
});

describe("the page never says or enforces a cap of 25 (Sam's quantity rule)", () => {
  it("no copy or code on the route states an 'up to 25' limit", () => {
    const files = [...FILES, "components/waitlist/over-invite-confirm.tsx", "components/waitlist/recipient-chooser.tsx"];
    for (const f of files) {
      expect(code(f), f).not.toMatch(/up to 25|first 25|only 25|max(imum)?(?: of)? 25|25 (at a time|per (send|batch))/i);
    }
  });
  it("the chunk is only ever the claim's page size, and the action loops until the queue is empty", () => {
    const actions = read("app/(app)/settings/waitlist/over-invite/actions.ts");
    expect(actions).toMatch(/while \(claimedAny/);
    expect(actions).not.toMatch(/entryIds\.slice\(|\.slice\(0, *25\)/);
  });
});
