import { describe, expect, it } from "vitest";
import { publishedServicePriceReads, staffMaySeePublishedServicePrices } from "@/lib/booking/service-price-visibility";

describe("See published service prices and booking fees (default ON, owners always)", () => {
  it("the interim reader answers the default, ON, until the permission engine stores the control", async () => {
    expect(await staffMaySeePublishedServicePrices("s1")).toBe(true);
  });

  it("ON: staff and owners read prices (today's behaviour)", async () => {
    expect(await publishedServicePriceReads("s1", false)).toEqual({ includePrices: true });
    expect(await publishedServicePriceReads("s1", true)).toEqual({ includePrices: true });
  });

  it("OFF: staff read no price; the owner still does", async () => {
    const off = async () => false;
    expect(await publishedServicePriceReads("s1", false, off)).toEqual({ includePrices: false });
    expect(await publishedServicePriceReads("s1", true, off)).toEqual({ includePrices: true });
  });

  it("the owner never consults the control (it cannot lock an owner out of prices)", async () => {
    let asked = 0;
    await publishedServicePriceReads("s1", true, async () => { asked += 1; return false; });
    expect(asked).toBe(0);
  });

  it("the control is passed the studio it governs", async () => {
    let seen = "";
    await publishedServicePriceReads("studio-9", false, async (id) => { seen = id; return true; });
    expect(seen).toBe("studio-9");
  });
});
