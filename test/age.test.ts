import { describe, expect, it } from "vitest";
import { ageOn, todayIn } from "@/lib/age";

describe("derived patient age", () => {
  it("counts completed years", () => {
    expect(ageOn("1990-05-12", "2026-05-11")).toBe(35);
    expect(ageOn("1990-05-12", "2026-05-12")).toBe(36);
    expect(ageOn("1990-05-12", "2026-12-31")).toBe(36);
  });

  it("treats a 29 February birthday as passed on 1 March in non-leap years", () => {
    expect(ageOn("2000-02-29", "2027-02-28")).toBe(26);
    expect(ageOn("2000-02-29", "2027-03-01")).toBe(27);
    expect(ageOn("2000-02-29", "2028-02-29")).toBe(28);
  });

  it("returns null for missing, invalid or future dates", () => {
    expect(ageOn(null, "2026-01-01")).toBeNull();
    expect(ageOn("", "2026-01-01")).toBeNull();
    expect(ageOn("12/05/1990", "2026-01-01")).toBeNull();
    expect(ageOn("2027-01-01", "2026-01-01")).toBeNull();
    expect(ageOn("2026-01-01", "2026-01-01")).toBe(0);
  });

  it("computes today in the clinic time zone", () => {
    // 2026-09-24 22:30 UTC is already 2026-09-25 in Riyadh (UTC+3).
    const instant = new Date("2026-09-24T22:30:00Z");
    expect(todayIn("Asia/Riyadh", instant)).toBe("2026-09-25");
    expect(todayIn("UTC", instant)).toBe("2026-09-24");
  });
});
