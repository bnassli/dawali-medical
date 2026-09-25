import { describe, expect, it } from "vitest";
import { comboText, parseComboText } from "@/modules/clinical/combo-text";

const opt = (id: string, label: string, isActive = true) => ({ id, label, isActive });
const OPTIONS = [opt("a", "for many years"), opt("b", "for several months"), opt("old", "Old wording", false)];
const empty = { optionIds: [], freeText: "" };

describe("SonoSoft combo box text (R1b, ADR-029)", () => {
  it("shows the option, the free text, or both joined by a comma", () => {
    expect(comboText(empty, OPTIONS)).toBe("");
    expect(comboText({ optionIds: ["a"], freeText: "" }, OPTIONS)).toBe("for many years");
    expect(comboText({ optionIds: [], freeText: "since 2019" }, OPTIONS)).toBe("since 2019");
    expect(comboText({ optionIds: ["a"], freeText: "left leg" }, OPTIONS)).toBe("for many years, left leg");
  });

  it("clearing the box clears the value", () => {
    expect(parseComboText("   ", { optionIds: ["a"], freeText: "x" }, OPTIONS)).toEqual(empty);
  });

  it("keeps the chosen option while its text is kept; text after the comma is visit-only", () => {
    const current = { optionIds: ["a"], freeText: "" };
    expect(parseComboText("for many years", current, OPTIONS)).toEqual({ optionIds: ["a"], freeText: "" });
    expect(parseComboText("for many years, left leg", current, OPTIONS)).toEqual({
      optionIds: ["a"],
      freeText: "left leg",
    });
  });

  it("round-trips what it displays", () => {
    const value = { optionIds: ["b"], freeText: "worse at night" };
    expect(parseComboText(comboText(value, OPTIONS), value, OPTIONS)).toEqual(value);
  });

  it("typing an active option's label (any case) chooses it; a retired label does not", () => {
    expect(parseComboText("FOR SEVERAL MONTHS", empty, OPTIONS)).toEqual({ optionIds: ["b"], freeText: "" });
    expect(parseComboText("Old wording", empty, OPTIONS)).toEqual({ optionIds: [], freeText: "Old wording" });
  });

  it("a retired option already on the visit stays chosen while its text is unchanged", () => {
    const current = { optionIds: ["old"], freeText: "" };
    expect(parseComboText("Old wording", current, OPTIONS)).toEqual(current);
  });

  it("changing the option's text turns the whole box into visit-only text (the option is dropped)", () => {
    const current = { optionIds: ["a"], freeText: "" };
    expect(parseComboText("for many yrs", current, OPTIONS)).toEqual({ optionIds: [], freeText: "for many yrs" });
  });
});
