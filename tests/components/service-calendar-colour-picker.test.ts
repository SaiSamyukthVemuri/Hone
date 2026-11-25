// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CalendarColorField, DurationField } from "@/app/(app)/settings/services/ServiceFormControls";
import { SERVICE_COLOR_KEYS, serviceColorClasses } from "@/lib/calendar/service-colors";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function mount(color: string | null, serviceName = "Consultation") {
  await act(async () => root.render(createElement("form", null,
    createElement(CalendarColorField, {
      name: "calendar_color", defaultValue: color, previewName: serviceName, previewDuration: 30, timeFormat: "24h",
    }),
    createElement("input", { name: "name", defaultValue: serviceName }),
    createElement(DurationField, { name: "default_duration_minutes", defaultValue: 30 }),
  )));
  return {
    form: host.querySelector("form")!,
    sample: host.querySelector('[data-testid="service-calendar-preview"]')!,
    swatches: Array.from(host.querySelectorAll<HTMLButtonElement>("fieldset button")),
  };
}

it("shows all ten named choices, uses the stored colour on the example and submits the selected key", async () => {
  const { form, sample, swatches } = await mount("emerald");
  const labels = swatches.map((button) => button.getAttribute("aria-label"));
  expect(labels).toEqual(SERVICE_COLOR_KEYS.map((key) => `Calendar color: ${key}`));
  expect(swatches.map(button => button.textContent)).toEqual([...SERVICE_COLOR_KEYS]);
  expect(swatches.filter(button => button.getAttribute("aria-pressed") === "true").map(button => button.textContent)).toEqual(["emerald"]);
  expect(new FormData(form).get("calendar_color")).toBe("emerald");
  expect(sample.className).toContain(serviceColorClasses("emerald"));

  const dirtied: FormDataEntryValue[] = [];
  form.addEventListener("input", () => dirtied.push(new FormData(form).get("calendar_color")!));
  for (const button of swatches) {
    await act(async () => button.click());
    expect(new FormData(form).get("calendar_color")).toBe(button.textContent);
    expect(sample.className).toContain(serviceColorClasses(button.textContent));
    expect(dirtied.at(-1)).toBe(button.textContent);
  }
});

it("reflects draft names, duration presets, and empty inputs, and restores the sample on form reset", async () => {
  const { form, sample } = await mount("sky", "");
  expect(sample.textContent).toContain("New service");
  expect(sample.textContent).toContain("09:00 – 09:30");
  const name = form.elements.namedItem("name") as HTMLInputElement;
  await act(async () => {
    name.value = "Follow-up";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    const preset = [...form.querySelectorAll("button")].find(b => b.textContent === "90")!;
    preset.click();
  });
  expect(sample.textContent).toContain("Follow-up");
  expect(sample.textContent).toContain("09:00 – 10:30");

  const duration = form.elements.namedItem("default_duration_minutes") as HTMLInputElement;
  await act(async () => {
    duration.value = "";
    duration.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(sample.textContent).not.toContain(" – ");
  await act(async () => form.reset());
  expect(sample.textContent).toContain("New service");
  expect(sample.textContent).toContain("09:00 – 09:30");
});

it("uses the original default for a legacy colour outside the allowed palette", async () => {
  const { form, sample } = await mount("rose");
  expect(new FormData(form).get("calendar_color")).toBe("sky");
  expect(sample.className).toContain(serviceColorClasses("sky"));
});
