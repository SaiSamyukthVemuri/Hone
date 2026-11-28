import { beforeEach, expect, it, vi } from "vitest";
import { createServiceAction, updateServiceAction } from "@/app/(app)/settings/services/actions";

const db = vi.hoisted(() => ({
  insert: vi.fn(),
  update: vi.fn(),
  select: vi.fn(),
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { role: "owner" }, studio: { id: "test-studio" },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: () => db }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

function olderForm() {
  const data = new FormData();
  data.set("name", "Consultation");
  data.set("default_duration_minutes", "30");
  data.set("sort_order", "10");
  return data;
}

beforeEach(() => vi.clearAllMocks());

it("saving an older service form cannot undo a newer reorder", async () => {
  db.update.mockReturnValue({ eq: () => ({ eq: async () => ({ error: null }) }) });
  const data = olderForm();
  data.set("id", "existing-service");
  await updateServiceAction(data);
  expect(db.update).toHaveBeenCalledOnce();
  expect(db.update.mock.calls[0][0]).toMatchObject({ name: "Consultation" });
  expect(db.update.mock.calls[0][0]).not.toHaveProperty("sort_order");
});

it("appends a new service after the last position even if a form submits an earlier one", async () => {
  const last = { data: { sort_order: 80 }, error: null };
  const query = {
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: async () => last,
  };
  db.select.mockReturnValue(query);
  db.insert.mockResolvedValue({ error: null });
  await createServiceAction(olderForm());
  expect(query.eq).toHaveBeenCalledWith("studio_id", "test-studio");
  expect(db.insert).toHaveBeenCalledWith(expect.objectContaining({ sort_order: 90 }));
});
