import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// UI-05 — every remaining native confirm() dialog, retired.
//
// WHY THIS IS NOT A STYLING SLICE. confirm-dialog.tsx's own docblock records
// that iOS Safari can SUPPRESS a native confirm silently. When it does, the
// guard returns false and the mutation never runs: a practitioner taps Remove
// or Archive, sees nothing happen, and cannot tell refusal from being ignored.
// Two other surfaces in this repo had already migrated for that reason and said
// so in their comments; these two were the stragglers.
//
// What the shipped dialog adds that a native one cannot: role="alertdialog",
// a focus trap, focus restored to the opener, Escape that closes ONLY while
// idle so an in-flight mutation is never abandoned, and an error region that
// keeps the dialog open so the message can be read.

const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SCHEDULE = code("components/treatment-schedule-editor.tsx");
const PORTAL = code("components/portal-messages-card.tsx");
// Found only after the sweep was widened — see sweptFiles() for why it was
// invisible. The slice originally claimed there were TWO; there were three.
const TAGS = code("components/client-tags-card.tsx");

/**
 * The files the sweep covers.
 *
 * The original pathspec — `'app/**' + '/*.tsx'` and the same for components —
 * looked repo-wide and was not: in a git pathspec that form requires at least
 * one intervening directory, so it matched 236 of 300 files and silently
 * skipped every TOP-LEVEL one: app/page.tsx, app/layout.tsx, and the whole of
 * components/*.tsx.
 *
 * That included BOTH files this slice fixed. treatment-schedule-editor.tsx and
 * portal-messages-card.tsx are top-level in components/, so the fence whose
 * entire claim is "zero native confirm anywhere" was green while never reading
 * its own subjects. It passed because the 236 files it did read genuinely had
 * none — a true answer reached without examining the evidence.
 *
 * Codex raised it. The coverage test below makes the omission impossible to
 * reintroduce quietly.
 */
function sweptFiles(): string[] {
  return execSync("git ls-files '*.tsx' '*.ts'", { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => f.startsWith("app/") || f.startsWith("components/"));
}

describe("UI-05: no native confirm survives anywhere in the app", () => {
  it("app/ and components/ contain ZERO live native confirm calls", () => {
    // Repo-wide, not just the two files touched — otherwise a third could
    // appear tomorrow and this slice would still read as complete. Comments
    // mentioning the old API are allowed; a call is not.
    //
    // QUALIFIED *AND* UNQUALIFIED. The first version of this sweep matched only
    // `window.confirm(`, so a bare `confirm("…")` — the same global, reached
    // without the receiver — would have walked straight through a test whose
    // entire claim is "zero native confirm anywhere". Codex raised that as a P2
    // and was right: the fence was narrower than its own name.
    //
    // The unqualified pattern deliberately excludes a preceding word character,
    // `.` or `$`, so `onConfirm(`, `handleConfirm(` and `dialog.confirm(` are
    // not false positives; `globalThis`/`self` receivers are matched explicitly.
    // SHADOWING IS REAL, and the first widened version of this sweep tripped on
    // it immediately: app/(app)/calendar/PostcareSendButton.tsx declares
    // `function confirm()` of its own, so every bare `confirm()` in that file
    // resolves to the LOCAL binding and has nothing to do with the native
    // global. Flagging it would have been a false positive on correct code —
    // the opposite error to the one Codex caught, and just as wrong.
    //
    // So a file that declares its own `confirm` is exempt from the bare-call
    // check; the qualified receivers are still checked there, because
    // `window.confirm(` is unambiguous regardless of local bindings.
    const DECLARES_OWN = /(?:function\s+confirm\s*\(|(?:const|let|var)\s+confirm\s*=)/;

    const QUALIFIED: Array<[string, RegExp]> = [
      ["window.confirm", /\bwindow\s*\.\s*confirm\s*\(/],
      ["globalThis.confirm", /\bglobalThis\s*\.\s*confirm\s*\(/],
      ["self.confirm", /\bself\s*\.\s*confirm\s*\(/],
    ];
    const BARE = /(?<![\w.$])confirm\s*\(/;

    const hits = sweptFiles()
      .flatMap((f) => {
        const stripped = code(f);
        const matched = QUALIFIED.filter(([, re]) => re.test(stripped)).map(([n]) => n);
        if (!DECLARES_OWN.test(stripped) && BARE.test(stripped)) {
          matched.push("bare confirm()");
        }
        return matched.length ? [`${f} (${matched.join(", ")})`] : [];
      });
    expect(hits, `native confirm still called in: ${hits.join(" | ")}`).toEqual([]);
  });

  it("the sweep COVERS the files this slice fixed, and the whole surface", () => {
    // Without this, a pathspec that quietly stops matching turns the assertion
    // above into a tautology: zero hits across zero relevant files, reported
    // green. The original pathspec did exactly that.
    const swept = sweptFiles();
    for (const subject of [
      "components/treatment-schedule-editor.tsx",
      "components/portal-messages-card.tsx",
      "components/client-tags-card.tsx",
    ]) {
      expect(swept, `the sweep must actually read ${subject}`).toContain(subject);
    }
    // Top-level files were the entire blind spot.
    expect(swept).toContain("app/layout.tsx");
    expect(swept).toContain("app/page.tsx");

    // And the list is the FULL surface, derived from git rather than a number
    // restated here where it could drift.
    const all = execSync("git ls-files '*.tsx' '*.ts'", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((f) => f.startsWith("app/") || f.startsWith("components/"));
    expect(swept.length).toBe(all.length);
    expect(swept.length).toBeGreaterThan(280);
  });

  it("the sweep's own patterns actually MATCH — proved on synthetic inputs", () => {
    // A negative-only sweep passes just as well when its regexes are broken.
    // These pin that each form is caught and that the near-miss identifiers are
    // not, which is the half a green repo cannot demonstrate.
    const bare = /(?<![\w.$])confirm\s*\(/;
    const declares = /(?:function\s+confirm\s*\(|(?:const|let|var)\s+confirm\s*=)/;

    // TRUE POSITIVES — the forms that must be caught.
    expect(bare.test('if (!confirm("go?")) return;')).toBe(true);
    expect(bare.test("confirm ('spaced')")).toBe(true);
    expect(/\bwindow\s*\.\s*confirm\s*\(/.test("window . confirm(1)")).toBe(true);

    // NEAR MISSES — identifiers that merely contain the word.
    expect(bare.test("onConfirm()")).toBe(false);
    expect(bare.test("handleConfirm()")).toBe(false);
    expect(bare.test("dialog.confirm()")).toBe(false);

    // SHADOWING — a file declaring its own `confirm` is exempt from the bare
    // check. Both halves asserted: the declaration is recognised, and the
    // bare pattern alone would otherwise have matched its call sites.
    const shadowed = 'function confirm() { run(); }\nonClick={() => confirm()}';
    expect(declares.test(shadowed)).toBe(true);
    expect(bare.test(shadowed)).toBe(true); // why the exemption is needed
    expect(declares.test('if (!confirm("go?")) return;')).toBe(false);
    expect(declares.test("const confirm = () => {}")).toBe(true);
  });
});

describe("UI-05: both surfaces use the shipped dialog with its real contract", () => {
  it("each mounts ConfirmDialog with danger tone and a busy label", () => {
    for (const [name, src] of [
      ["schedule", SCHEDULE],
      ["portal", PORTAL],
      ["tags", TAGS],
    ] as const) {
      expect(src, `${name} imports the dialog`).toContain(
        'from "@/components/confirm-dialog"',
      );
      expect(src, `${name} mounts it`).toMatch(/<ConfirmDialog/);
      expect(src, `${name} is destructive`).toMatch(/tone="danger"/);
      expect(src, `${name} names the in-flight state`).toMatch(/busyLabel="/);
    }
  });

  it("the caller still owns the mutation — pending is passed, not invented", () => {
    // The dialog is presentation. Each caller keeps its own transition and
    // passes `pending` in, which is what locks the dialog against Escape and
    // double-submit.
    expect(SCHEDULE).toMatch(/pending=\{pending\}/);
    expect(PORTAL).toMatch(/pending=\{archivePending\}/);
  });

  it("failure keeps the dialog OPEN and does not render the error twice", () => {
    // On failure each handler sets the error and leaves the dialog open, per
    // the dialog's error contract; the surface's own error paragraph is then
    // suppressed so the message is not shown in two places at once.
    expect(SCHEDULE).toMatch(/error=\{confirming \? error : null\}/);
    expect(SCHEDULE).toMatch(/\{error && !confirming && \(/);
    expect(PORTAL).toMatch(/error=\{archiveTarget \? archiveError : null\}/);
    expect(PORTAL).toMatch(/\{archiveError && !archiveTarget && \(/);
  });

  it("success closes the dialog; failure does not", () => {
    expect(SCHEDULE).toMatch(/if \(r\.ok\) \{\s*setConfirming\(false\);/);
    expect(PORTAL).toMatch(/if \(r\.ok\) \{\s*setArchiveTarget\(null\);/);
  });

  it("the portal card tracks WHICH message, which confirm() carried implicitly", () => {
    // A native confirm knew its target from the call stack. A mounted dialog
    // must be told, and `runArchive` must refuse to fire without one — losing
    // that would archive whatever the last-known id happened to be.
    expect(PORTAL).toMatch(/const \[archiveTarget, setArchiveTarget\]/);
    expect(PORTAL).toMatch(/open=\{archiveTarget !== null\}/);
    expect(PORTAL).toMatch(/if \(!archiveTarget\) return;/);
    expect(PORTAL).toMatch(/fd\.set\("message_id", archiveTarget\)/);
  });

  it("the tags card tracks WHICH tag, and refuses to fire without one", () => {
    // Same defect class as the portal card: a native confirm knew its target
    // from the call stack, a mounted dialog must be told. Losing this guard
    // would remove whatever id happened to be last.
    expect(TAGS).toMatch(/const \[removeTarget, setRemoveTarget\]/);
    expect(TAGS).toMatch(/open=\{removeTarget !== null\}/);
    expect(TAGS).toMatch(/if \(!removeTarget\) return;/);
    expect(TAGS).toMatch(/error=\{removeTarget \? error : null\}/);
    expect(TAGS).toMatch(/\{error && !removeTarget && \(/);
    expect(TAGS).toMatch(/await removeAction\(fd\)/);
    expect(TAGS).toMatch(/fd\.set\("tag_id", tagId\)/);
  });

  it("no mutation contract changed — same actions, same FormData fields", () => {
    expect(SCHEDULE).toMatch(/fd\.set\("stage_id", stage\.id\)/);
    expect(SCHEDULE).toMatch(/fd\.set\("plan_id", planId\)/);
    expect(SCHEDULE).toMatch(/fd\.set\("client_id", clientId\)/);
    expect(SCHEDULE).toMatch(/await deleteAction\(fd\)/);
    expect(PORTAL).toMatch(/fd\.set\("client_id", clientId\)/);
    expect(PORTAL).toMatch(/await archiveAction\(fd\)/);
  });

  it("invents no dialog of its own, and adds no dependency", () => {
    // The point is adoption. A second modal implementation here would be the
    // opposite of the slice.
    for (const src of [SCHEDULE, PORTAL]) {
      expect(src).not.toMatch(/role="alertdialog"/);
      expect(src).not.toMatch(/aria-modal/);
    }
    // NOT a global count pin. The earlier version asserted
    // `Object.keys(pkg.dependencies).length === 21`, which breaks this
    // slice's test on ANY legitimate dependency addition anywhere in the
    // repository — a false failure with nothing to do with confirm dialogs.
    // Codex flagged it as a P3 and the reasoning generalises: a slice test
    // should assert what the slice forbids, not a repo-wide total.
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    const deps = Object.keys(pkg.dependencies);
    for (const banned of [
      "framer-motion",
      "motion",
      "lucide-react",
      "clsx",
      "tailwind-merge",
      "@astryxdesign/core",
      "@radix-ui/react-dialog",
      "@headlessui/react",
      "sweetalert2",
    ]) {
      expect(deps, `${banned} must not be a dependency`).not.toContain(banned);
    }
  });
});
