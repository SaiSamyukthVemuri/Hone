import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// Review follow-ups to #1375 and #1384 (Insurance F-2, F-3, F-4/H-2, P-1). Test-only.
vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// F-3: the fail-closed branches of getLatestSignaturesForPractitionerView.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const fake = {
  templates: [] as Row[],
  cards: [] as Row[],
  signatures: [] as Row[],
  failTable: null as string | null,
  reads: [] as string[],
};

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      fake.reads.push(table);
      let rows =
        table === "consent_form_templates" ? [...fake.templates]
        : table === "client_payment_methods" ? [...fake.cards]
        : [...fake.signatures];
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
        in: (c: string, l: unknown[]) => { rows = rows.filter((r) => l.includes(r[c])); return q; },
        not: (c: string, op: string, l: string) => {
          if (op === "is") { rows = rows.filter((r) => r[c] != null); return q; }
          const ids = l.replace(/[()]/g, "").split(",");
          rows = rows.filter((r) => !ids.includes(String(r[c])));
          return q;
        },
        order: (c: string, o?: { ascending?: boolean }) => {
          if (o?.ascending === false) rows = [...rows].sort((a, b) => String(b[c]).localeCompare(String(a[c])));
          return q;
        },
        then: (res: (v: unknown) => void) =>
          res(fake.failTable === table ? { data: null, error: { code: "XX000", message: "boom" } } : { data: rows, error: null }),
      };
      return q;
    },
  }),
}));

const NO_CARD = { includeCardAuthorization: false };

beforeEach(() => {
  fake.templates = [
    { id: "t-photo", studio_id: "s1", form_type: "photo_consent", title: "Photo" },
    { id: "t-card", studio_id: "s1", form_type: "card_authorization", title: "Card" },
  ];
  fake.cards = [];
  fake.signatures = [
    { id: "g1", studio_id: "s1", client_id: "c1", template_id: "t-photo", signed_at: "2026-10-01T00:00:00Z" },
    { id: "g2", studio_id: "s1", client_id: "c1", template_id: "t-card", signed_at: "2026-10-02T00:00:00Z" },
  ];
  fake.failTable = null;
  fake.reads = [];
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const FAILED = "consent_signatures_for_practitioner_failed";
function loggedEvents(): string[] {
  return (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => {
    try { return String(JSON.parse(String(c[0])).event); } catch { return ""; }
  });
}

describe("F-3: the signature loader fails closed", () => {
  it("control: the happy path returns only the non-card signature and logs nothing", async () => {
    const { getLatestSignaturesForPractitionerView } = await import("@/lib/consent/queries");
    expect((await getLatestSignaturesForPractitionerView("s1", "c1", NO_CARD)).map((s) => s.id)).toEqual(["g1"]);
    expect(loggedEvents()).toEqual([]);
  });

  it.each(["consent_form_templates", "client_payment_methods"])(
    "a read error on %s takes the classification-error branch: returns nothing, logs, never reads signatures",
    async (table) => {
      fake.failTable = table;
      const { getLatestSignaturesForPractitionerView } = await import("@/lib/consent/queries");
      expect(await getLatestSignaturesForPractitionerView("s1", "c1", NO_CARD)).toEqual([]);
      expect(loggedEvents()).toEqual([FAILED]); // the empty-set early return logs nothing, so this is the error branch
      expect(fake.reads).not.toContain("client_consent_signatures");
    },
  );

  it("an empty allowed set (no non-card template) returns nothing, logs nothing, never reads signatures", async () => {
    fake.templates = [{ id: "t-card", studio_id: "s1", form_type: "card_authorization", title: "Card" }];
    const { getLatestSignaturesForPractitionerView } = await import("@/lib/consent/queries");
    expect(await getLatestSignaturesForPractitionerView("s1", "c1", NO_CARD)).toEqual([]);
    expect(loggedEvents()).toEqual([]);
    expect(fake.reads).not.toContain("client_consent_signatures");
  });

  it("a signature read error returns nothing and is logged (the empty result alone could not tell)", async () => {
    fake.failTable = "client_consent_signatures";
    const { getLatestSignaturesForPractitionerView } = await import("@/lib/consent/queries");
    expect(await getLatestSignaturesForPractitionerView("s1", "c1", NO_CARD)).toEqual([]);
    expect(loggedEvents()).toEqual([FAILED]);
  });

  it("A-2: a signature on an allowed template that THIS client's card points at is withheld; another client's pointer does not withhold it", async () => {
    fake.signatures = [
      { id: "g1", studio_id: "s1", client_id: "c1", template_id: "t-photo", signed_at: "2026-10-01T00:00:00Z" },
      { id: "g7", studio_id: "s1", client_id: "c1", template_id: "t-photo", signed_at: "2026-10-03T00:00:00Z" },
    ];
    // Two photo signatures on one template: the latest per template is g7, so point the card at g7.
    fake.cards = [{ studio_id: "s1", client_id: "c1", card_authorization_signature_id: "g7" }];
    const { getLatestSignaturesForPractitionerView } = await import("@/lib/consent/queries");
    expect((await getLatestSignaturesForPractitionerView("s1", "c1", NO_CARD)).map((s) => s.id)).toEqual(["g1"]);
    fake.cards = [{ studio_id: "s1", client_id: "c2", card_authorization_signature_id: "g7" }];
    expect((await getLatestSignaturesForPractitionerView("s1", "c1", NO_CARD)).map((s) => s.id)).toEqual(["g7"]);
  });
});

// ---------------------------------------------------------------------------
// F-4/H-2: the templates list for a non-owner is pinned in full.
// ---------------------------------------------------------------------------
describe("H-2: the non-owner template list is exactly the non-card templates", () => {
  it("returns the full expected list, in every form type", async () => {
    fake.templates = [
      { id: "a", studio_id: "s1", form_type: "general", status: "active", created_at: "1" },
      { id: "b", studio_id: "s1", form_type: "treatment_consent", status: "active", created_at: "1" },
      { id: "c", studio_id: "s1", form_type: "policy_acknowledgement", status: "active", created_at: "1" },
      { id: "d", studio_id: "s1", form_type: "photo_consent", status: "active", created_at: "1" },
      { id: "e", studio_id: "s1", form_type: "card_authorization", status: "active", created_at: "1" },
      { id: "f", studio_id: "s1", form_type: "brand_new_type", status: "active", created_at: "1" },
      { id: "g", studio_id: "s2", form_type: "general", status: "active", created_at: "1" },
    ];
    const { getConsentTemplatesForStudio } = await import("@/lib/consent/queries");
    const out = await getConsentTemplatesForStudio("s1", NO_CARD);
    expect(out.map((t) => t.id).sort()).toEqual(["a", "b", "c", "d"]);
  });
});

// ---------------------------------------------------------------------------
// F-4/H-2: the omission guard reads the syntax tree, not text.
// ---------------------------------------------------------------------------
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next") continue;
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (c) => visit(c, fn));
}

const LOADERS = ["getConsentTemplatesForStudio", "getLatestSignaturesForPractitionerView"];

describe("no caller reaches a card-authorization loader without naming the scope", () => {
  it("every reference is a direct call whose scope argument is an object literal naming includeCardAuthorization", { timeout: 60_000 }, () => {
    const files = [...sourceFiles("app"), ...sourceFiles("lib"), ...sourceFiles("components")].filter(
      (f) => f !== join("lib", "consent", "queries.ts"),
    );
    const seen: string[] = [];
    for (const f of files) {
      const sf = parse(f);
      visit(sf, (n) => {
        if (ts.isImportSpecifier(n)) {
          // An aliased import would hide the name from this guard.
          if (LOADERS.includes((n.propertyName ?? n.name).text)) {
            expect(n.propertyName, `${f}: loader imported under an alias`).toBeUndefined();
          }
          return;
        }
        if (!ts.isIdentifier(n) || !LOADERS.includes(n.text)) return;
        if (ts.isImportSpecifier(n.parent) || ts.isTypeQueryNode(n.parent)) return; // `typeof loader` is type-only
        seen.push(f);
        const call = n.parent;
        expect(ts.isCallExpression(call) && call.expression === n, `${f}: ${n.text} used other than as a direct call`).toBe(true);
        const args = (call as ts.CallExpression).arguments;
        const scope = args[args.length - 1];
        expect(scope && ts.isObjectLiteralExpression(scope), `${f}: ${n.text} scope is not an object literal`).toBe(true);
        const names = (scope as ts.ObjectLiteralExpression).properties.map((p) => (p.name && "text" in p.name ? p.name.text : ""));
        expect(names, `${f}: ${n.text}`).toContain("includeCardAuthorization");
      });
    }
    expect(new Set(seen).size).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// F-2: an inactive owner is refused by the real identity resolver.
// ---------------------------------------------------------------------------
describe("F-2: an inactive owner never becomes the viewer", () => {
  it("requirePractitionerWithStudio redirects an inactive owner and resolves an active one", async () => {
    vi.resetModules();
    const PRACTITIONERS: Row[] = [
      { id: "p-inactive", user_id: "u-inactive", studio_id: "s1", role: "owner", active: false, studio: { id: "s1" } },
      { id: "p-owner", user_id: "u-owner", studio_id: "s1", role: "owner", active: true, studio: { id: "s1" } },
    ];
    let userId = "u-inactive";
    vi.doMock("next/navigation", () => ({
      redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
    }));
    vi.doMock("@/lib/supabase/selected-studio", () => ({ readSelectedStudioId: async () => null }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => ({
        auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
        from() {
          let rows = [...PRACTITIONERS];
          const q: Record<string, unknown> = {
            select: () => q,
            eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
            then: (res: (v: unknown) => void) => res({ data: rows, error: null }),
          };
          return q;
        },
      }),
    }));
    try {
      const { requirePractitionerWithStudio } = await import("@/lib/supabase/queries");
      const { canViewClientBilling } = await import("@/lib/clients/profile-tabs");

      userId = "u-inactive";
      await expect(requirePractitionerWithStudio()).rejects.toThrow("REDIRECT:/no-access");

      userId = "u-owner";
      const ok = await requirePractitionerWithStudio();
      expect(canViewClientBilling(ok.practitioner.role)).toBe(true);
    } finally {
      vi.doUnmock("next/navigation");
      vi.doUnmock("@/lib/supabase/selected-studio");
      vi.doUnmock("@/lib/supabase/server");
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// #1375 Insurance P-1 / #1384 A-1: the owner gate is resolved to its declaration, not matched by name.
// ---------------------------------------------------------------------------
const OWNER_DECL = /^(canViewClientBilling\(practitioner\.role\)|practitioner\.role === "owner")$/;

// The value expression a name was declared with, in the same file (const only).
function declaredValue(sf: ts.SourceFile, name: string): string | null {
  let found: string | null = null;
  visit(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      found = n.initializer.getText(sf);
    }
  });
  return found;
}

// An owner-derived expression: a direct owner comparison / canViewClientBilling, or `isOwner` whose
// declaration in the SAME file is one of those.
function ownerDerived(sf: ts.SourceFile, expr: string): boolean {
  if (OWNER_DECL.test(expr)) return true;
  if (expr === "isOwner") {
    const decl = declaredValue(sf, "isOwner");
    return decl != null && OWNER_DECL.test(decl);
  }
  return false;
}

function propName(p: ts.ObjectLiteralElementLike): string {
  if (!p.name) return "";
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text;
  return "";
}

describe("P-1: includePrices is only ever derived from the owner role", () => {
  it("every includePrices key (identifier or quoted) in app/, components/ and lib/ resolves to an owner gate", () => {
    const files = [...sourceFiles("app"), ...sourceFiles("components"), ...sourceFiles("lib")];
    const found: string[] = [];
    for (const f of files) {
      const sf = parse(f);
      visit(sf, (n) => {
        if (ts.isShorthandPropertyAssignment(n) && n.name.text === "includePrices") {
          throw new Error(`${f}: includePrices shorthand hides its source`);
        }
        if (ts.isPropertyAssignment(n) && propName(n) === "includePrices") {
          const text = n.initializer.getText(sf);
          // Type positions (`includePrices?: boolean`) are not assignments; a literal false is the safe value.
          if (text === "false") return;
          found.push(`${f}: ${text}`);
          const ok = ownerDerived(sf, text);
          expect(ok, `${f}: includePrices: ${text}`).toBe(true);
        }
        // `const priceReads = { includePrices: isOwner }` is checked above; a bare `priceReads` argument must
        // resolve to such a declaration in the same file.
        if (ts.isCallExpression(n)) {
          for (const a of n.arguments) {
            if (ts.isIdentifier(a) && a.text === "priceReads") {
              const decl = declaredValue(sf, "priceReads");
              expect(decl, `${f}: priceReads has no declaration`).not.toBeNull();
              expect(decl, `${f}: priceReads`).toMatch(/^\{ includePrices: (isOwner|practitioner\.role === "owner") \}$/);
            }
          }
        }
      });
    }
    expect(found.length).toBeGreaterThanOrEqual(2);
  });

  it("a file that defines isOwner as a constant true would not pass the resolver", () => {
    const sf = ts.createSourceFile("x.tsx", "const isOwner = true; read({ includePrices: isOwner });", ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect(ownerDerived(sf, "isOwner")).toBe(false);
    expect(ownerDerived(sf, "true")).toBe(false);
  });
});

describe("A-1: the card scope value is owner-derived, or a literal true only on a page that refuses non-owners", () => {
  it("every loader call's includeCardAuthorization value resolves", () => {
    const files = [...sourceFiles("app"), ...sourceFiles("lib"), ...sourceFiles("components")].filter(
      (f) => f !== join("lib", "consent", "queries.ts"),
    );
    let checked = 0;
    for (const f of files) {
      const sf = parse(f);
      visit(sf, (n) => {
        if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || !LOADERS.includes(n.expression.text)) return;
        const scope = n.arguments[n.arguments.length - 1] as ts.ObjectLiteralExpression;
        const prop = scope.properties.find((p) => propName(p) === "includeCardAuthorization") as ts.PropertyAssignment | undefined;
        expect(prop, `${f}: scope lacks includeCardAuthorization`).toBeDefined();
        const text = prop!.initializer.getText(sf);
        checked += 1;
        if (text === "true") {
          // Allowed only where the page refuses a non-owner before this read.
          expect(sf.getText(), `${f}: literal true on a page with no owner refusal`).toMatch(/practitioner\.role !== "owner"/);
        } else if (text !== "false") {
          expect(ownerDerived(sf, text), `${f}: includeCardAuthorization: ${text}`).toBe(true);
        }
      });
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });
});
