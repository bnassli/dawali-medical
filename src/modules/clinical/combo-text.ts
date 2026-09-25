/**
 * SonoSoft's combo box (R1b, ADR-029): one text box that shows the chosen
 * option and accepts any typed text. These rules turn that text back into the
 * stored value `{ optionIds, freeText }`; they decide what is saved, so they
 * live here and are unit tested (test/combo-text.test.ts).
 */
import type { EntryValue, OptionView } from "@/modules/clinical/autosave-client";

/** Text shown in a combo box for a single-choice value: "Option, free text". */
export function comboText(value: EntryValue, options: OptionView[]): string {
  const selected = options.find((o) => o.id === value.optionIds[0]);
  if (!selected) return value.freeText;
  return value.freeText ? `${selected.label}, ${value.freeText}` : selected.label;
}

/**
 * What typing in a combo box means (SonoSoft combos accept any text):
 * keeping the chosen option's text keeps the option (anything after "Option, "
 * is free text); typing exactly an option's label chooses it; anything else is
 * visit-only free text.
 */
export function parseComboText(text: string, current: EntryValue, options: OptionView[]): EntryValue {
  const t = text.trim();
  if (t === "") return { optionIds: [], freeText: "" };
  const selected = options.find((o) => o.id === current.optionIds[0]);
  if (selected) {
    if (t === selected.label) return { optionIds: [selected.id], freeText: "" };
    if (t.startsWith(`${selected.label},`)) {
      return { optionIds: [selected.id], freeText: t.slice(selected.label.length + 1).trim() };
    }
  }
  const exact = options.find((o) => o.isActive && o.label.toLowerCase() === t.toLowerCase());
  if (exact) return { optionIds: [exact.id], freeText: "" };
  return { optionIds: [], freeText: text };
}
