import { describe, expect, it } from "vitest";
import { scrubErrorEvent } from "@/lib/observability/sentry-scrub";

// G-26 Option B: what Sentry could attach if the open route threw. The form body carries the client id and the day.
const CLIENT = "7c1d2e3f-4a5b-4c6d-8e7f-a1b2c3d4e5f6";
const DAY = "2020-02-17";
describe("a Sentry event for the open route carries neither value", () => {
  it("object body, urlencoded string body and the URL", () => {
    const shapes = [
      { clientId: CLIENT, day: DAY },
      `clientId=${CLIENT}&day=${DAY}`,
    ];
    for (const data of shapes) {
      const out = scrubErrorEvent({ request: { url: "https://hone.test/records/print/open", method: "POST", data } } as never);
      const text = JSON.stringify(out);
      expect(text, JSON.stringify(data)).not.toContain(CLIENT);
      expect(text, JSON.stringify(data)).not.toContain(DAY);
    }
  });
});
