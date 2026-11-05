// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";

import { useHeldBlockVersion } from "@/lib/sessions/use-held-block-version";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Insurance N-4 (#1369 818410af2): the identity write revalidates the session page, which can hand an OPEN, edited form a
// newer block version. The form must keep the version it holds; only its own write's returned token moves it.
let seen: { version: string | null; adopt: (t: string) => void };
function Probe({ prop }: { prop: string | null }) {
  const [version, adopt] = useHeldBlockVersion(prop);
  seen = { version, adopt };
  return null;
}
let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
const render = async (prop: string | null) => {
  if (!host) {
    host = document.createElement("div");
    root = createRoot(host);
  }
  await act(async () => root!.render(createElement(Probe, { prop })));
};
afterEach(() => {
  act(() => root?.unmount());
  host = root = null;
});

describe("the held block version", () => {
  it("starts at the version the editor opened at", async () => {
    await render("v1");
    expect(seen.version).toBe("v1");
  });
  it("a revalidated, NEWER prop is not adopted (a concurrent edit stays refusable)", async () => {
    await render("v1");
    await render("v3");
    expect(seen.version).toBe("v1");
  });
  it("the identity write's own returned token IS adopted, and survives a later revalidated prop", async () => {
    await render("v1");
    await act(async () => seen.adopt("v2"));
    expect(seen.version).toBe("v2");
    await render("v2");
    await render("v4");
    expect(seen.version).toBe("v2");
  });
  it("the form takes its version from the hook and keeps no prop-derived adoption", () => {
    const src = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx", "utf8");
    expect(src).toMatch(/useHeldBlockVersion\(block\?\.updated_at \?\? null\)/);
    expect(src).toMatch(/onBlockVersion=\{\(token\) => \{\s*if \(block\) setHeldVersion\(token\);/);
    expect(src).not.toMatch(/adoptedVersion/);
  });

  // Privacy NB-1: every successful block save closes the editor, so the next open starts from the fresh prop and nothing needs adopting.
  it("a successful update save and a successful create save both close the form, and both mount sites close on it", () => {
    const form = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx", "utf8");
    expect(form).toMatch(/if \(!res\.ok\) \{\s*setError\(res\.error\);\s*return;\s*\}\s*closeForm\(\);/);
    expect(form).toMatch(/setSaveUnresolved\(false\);\s*closeForm\(\);/);
    expect(form).toMatch(/const closeForm = \(\) => \{[\s\S]*?\n {4}onCancel\(\);\n {2}\};/);
    const view = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx", "utf8");
    expect(view).toMatch(/onCancel=\{\(\) => setAdding\(false\)\}/);
    expect(view).toMatch(/onCancel=\{\(\) => setEditing\(false\)\}/);
  });
});
