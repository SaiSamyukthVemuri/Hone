import { describe, expect, it, vi } from "vitest";

// LOADING A RATE-LIMITED ACTION MUST NOT INITIALIZE EMAIL.
//
// REPRODUCED at 2beb64a6: importing the refusal taxonomy from the transport
// created lib/rate-limit/public.ts -> policy.ts -> new-client-waitlist-send.ts
// -> lib/email/client.ts, and client.ts does real work at module scope — the
// fake-transport deployment assertion, constructing the Resend client when
// configured, warning when it is not. So merely loading public booking, portal
// login, intake, consent or portal links evaluated email initialization for
// routes that send no email.
//
// THIS FILE EXISTS SEPARATELY, AND THAT IS THE WHOLE POINT. The assertion is
// about what a FRESH module graph pulls in, so it is only meaningful where
// nothing else has already imported the transport. Placed alongside the other
// delivery tests it passed unconditionally, because those import the send path
// at the top and the warning had already fired before any spy attached.
//
// Import NOTHING at the top of this file beyond vitest.

describe("a rate-limited action's module graph is free of email initialization", () => {
  it("importing lib/rate-limit/public emits no Resend initialization warning", async () => {
    const warnings: string[] = [];
    const spy = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      });
    try {
      await import("@/lib/rate-limit/public");
    } finally {
      spy.mockRestore();
    }
    expect(warnings.join("\n")).not.toContain("RESEND_API_KEY not set");
  });

  it("the email client is not in the graph at all", async () => {
    // Stronger than watching for the warning, which only fires when the key is
    // absent: if client.ts were reachable, this factory would run.
    let clientLoaded = false;
    vi.doMock("@/lib/email/client", () => {
      clientLoaded = true;
      return { resend: null, FROM_ADDRESS: "", getResendTransport: () => null };
    });
    vi.resetModules();
    await import("@/lib/rate-limit/public");
    expect(clientLoaded).toBe(false);
    vi.doUnmock("@/lib/email/client");
    vi.resetModules();
  });
});
