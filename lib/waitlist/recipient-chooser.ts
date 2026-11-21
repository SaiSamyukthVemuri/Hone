// The over-invite recipient chooser, as pure logic. A studio can have thousands of waiting people and the owner may confirm ANY number of them, so
// this does three separate things and keeps them apart:
//   - SEARCH narrows what is listed (a name or email fragment). It never changes who is selected.
//   - PAGINATION bounds how much is rendered at once. It never changes who is selected.
//   - SELECTION is a set of entry ids that lives outside both, so it survives paging and searching, and it has NO ceiling.
// Nothing here reads data or calls a command. The server re-validates every posted id (studio, owner, consent); this is a convenience.

export type Candidate = { entryId: string; name: string; email?: string };

export const DEFAULT_PAGE_SIZE = 50;

export type ChooserState = {
  query: string;
  /** Zero-based. Always clamped when read, so a shrinking search can never leave the owner on an empty page past the end. */
  page: number;
  selected: ReadonlySet<string>;
};

export type ChooserAction =
  | { type: "query"; query: string }
  | { type: "page"; page: number }
  | { type: "toggle"; entryId: string }
  | { type: "selectIds"; entryIds: readonly string[] }
  | { type: "deselectIds"; entryIds: readonly string[] }
  | { type: "clear" };

export const initialChooserState = (selected: Iterable<string> = []): ChooserState => ({ query: "", page: 0, selected: new Set(selected) });

export function chooserReducer(state: ChooserState, action: ChooserAction): ChooserState {
  switch (action.type) {
    case "query":
      // A new search starts at its first page; the selection is untouched.
      return { ...state, query: action.query, page: 0 };
    case "page":
      return { ...state, page: Number.isFinite(action.page) ? Math.max(0, Math.floor(action.page)) : 0 };
    case "toggle": {
      const next = new Set(state.selected);
      if (!next.delete(action.entryId)) next.add(action.entryId);
      return { ...state, selected: next };
    }
    case "selectIds": {
      const next = new Set(state.selected);
      for (const id of action.entryIds) next.add(id);
      return { ...state, selected: next };
    }
    case "deselectIds": {
      const next = new Set(state.selected);
      for (const id of action.entryIds) next.delete(id);
      return { ...state, selected: next };
    }
    case "clear":
      return { ...state, selected: new Set() };
  }
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().trim();

/** Case-insensitive match of every word of the query against the name or email. An empty query lists everyone. */
export function filterCandidates(all: readonly Candidate[], query: string): Candidate[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...all];
  return all.filter((c) => {
    const hay = `${norm(c.name)} ${norm(c.email ?? "")}`;
    return words.every((w) => hay.includes(w));
  });
}

export type PageView = { items: Candidate[]; page: number; pageCount: number; total: number; from: number; to: number };

export function pageOf(filtered: readonly Candidate[], page: number, pageSize: number = DEFAULT_PAGE_SIZE): PageView {
  const size = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : DEFAULT_PAGE_SIZE;
  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0), pageCount - 1);
  const items = filtered.slice(p * size, p * size + size);
  return { items, page: p, pageCount, total, from: total === 0 ? 0 : p * size + 1, to: p * size + items.length };
}

/** The ids the form posts: every selected id, once, in a stable order. NOT limited to the listed page and NOT capped. */
export function selectedIds(selected: ReadonlySet<string>): string[] {
  return [...selected];
}

/** How many of the listed (filtered) people are selected, for "Select all N matching" / "N of M selected" wording. */
export function selectedAmong(filtered: readonly Candidate[], selected: ReadonlySet<string>): number {
  let n = 0;
  for (const c of filtered) if (selected.has(c.entryId)) n += 1;
  return n;
}
