import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0180 was applied database-first. These pin the webhook route to the command
// it installed.
describe("0180 — the webhook route depends on the ordered card command", () => {
  const ROUTE = readFileSync(
    join(__dirname, "..", "..", "app/api/stripe/webhook/route.ts"),
    "utf8",
  );

  it("THE TRIPWIRE: the app calls the new command unconditionally, so the DB must go first", () => {
    // No feature flag and no fallback to the old two writes.
    expect(ROUTE).toMatch(/admin\.rpc\(\s*\n?\s*"save_client_card_on_file_ordered"/);
    // No conditional guarding the call, and no fallback to the old two writes.
    expect(ROUTE).not.toMatch(/if\s*\([^)]*save_client_card_on_file/);
    expect(ROUTE).not.toMatch(/\.update\(\{ status: "removed"/);
    expect(ROUTE).not.toMatch(/\.from\("client_payment_methods"\)\s*\n\s*\.insert\(\{/);
  });

  it("an RPC-absent failure must NOT be able to look like success", () => {
    // NEW APP + OLD DB is data-safe only because the missing command throws and
    // the parent releases the claim. If this ever became a `return`, the event
    // would be marked processed and the card silently lost.
    const handler = ROUTE.slice(ROUTE.indexOf("async function handleSetupIntentSucceeded"));
    const saveBlock = handler.slice(handler.indexOf("if (saveErr) {"));
    expect(saveBlock).toMatch(/throw new Error\(\s*\n?\s*`save_client_card_on_file_failed/);
    // Only the command's own lineage refusal (22023) is terminal.
    const terminalGuard = saveBlock.slice(0, saveBlock.indexOf("throw new Error("));
    expect(terminalGuard).toMatch(/saveErr\.code === "22023"/);
  });
});
