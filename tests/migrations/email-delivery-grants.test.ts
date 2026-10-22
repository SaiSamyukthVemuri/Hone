import { describe, expect, it } from "vitest";
import { emailDeliveryGrants as grants } from "./helpers/email-delivery-grants";

const BASE = "grant execute on function public.delivery(uuid) to service_role;";
const EXPECTED = ["execute | public.delivery(uuid) -> service_role"];
const STRAY = "grant execute on function public.delivery(uuid) to anon;";

describe("delivery exact-grant matcher regressions", () => {
  it.each([
    "GRANT service_role TO anon;",
    "grant service_role, another_role to authenticated;",
    "grant service_role to anon with admin option;",
    "alter default privileges in schema public grant execute on functions to anon;",
  ])("fails closed on membership/no-ON syntax: %s", (extra) => {
    expect(() => grants(BASE + extra)).toThrow(/Unsupported top-level GRANT/);
  });

  it.each([
    "comment on function public.delivery(uuid) is 'foo -- bar'; ",
    "comment on function public.delivery(uuid) is 'foo /* bar */'; ",
    "comment on function public.delivery(uuid) is 'foo; -- bar'; ",
    "comment on function public.delivery(uuid) is 'foo '' -- bar'; ",
    "comment on function public.delivery(uuid) is E'foo\\' -- bar'; ",
    'comment on function public."delivery;--name"(uuid) is \'text\'; ',
    "comment on function public.delivery(uuid) is $$foo; -- /* bar */$$; ",
    "comment on function public.delivery(uuid) is $note$foo; -- /* bar */$note$; ",
  ])("keeps the active grant after a quoted value: %s", (prefix) => {
    expect(grants(BASE + prefix + STRAY)).toEqual([
      "execute | public.delivery(uuid) -> anon",
      ...EXPECTED,
    ]);
  });

  it("ignores actual line, block and nested block comments", () => {
    expect(grants(
      "-- " + STRAY + "\n/* outer /* nested */ " + STRAY + " */" + BASE,
    )).toEqual(EXPECTED);
  });

  it("does not count grant text inside a function body or comment string", () => {
    expect(grants(
      "create function public.example() returns void as $fn$begin " + STRAY +
      " end;$fn$ language plpgsql; comment on function public.example() is '" +
      STRAY + "'; " + BASE,
    )).toEqual(EXPECTED);
  });

  it("retains comma-list, alternate privilege and schema-wide negatives", () => {
    expect(grants(
      BASE + "grant all on table public.receipts to anon, authenticated;" +
      "grant execute on all functions in schema public to public;",
    )).toEqual([
      "all | table public.receipts -> anon",
      "all | table public.receipts -> authenticated",
      "execute | all functions in schema public -> public",
      ...EXPECTED,
    ]);
  });

  it("allows comments between grant tokens without joining them", () => {
    expect(grants("grant/*comment*/execute on function public.delivery(uuid) to service_role;"))
      .toEqual(EXPECTED);
  });

  it.each([
    BASE + "/* unterminated",
    BASE + "comment on function public.delivery(uuid) is 'unterminated;",
    BASE + "comment on function public.delivery(uuid) is $tag$unterminated;",
  ])("refuses incomplete lexical evidence: %s", (sql) => {
    expect(() => grants(sql)).toThrow(/Unterminated SQL/);
  });
});
