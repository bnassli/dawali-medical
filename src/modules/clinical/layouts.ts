/**
 * Screen layout of each clinical tab, copied from the SonoSoft reference
 * screens (docs/reference/sonosoft/tabs/, Product Owner decision 2026-09-25,
 * ADR-029). Presentation only: which fields exist, their types and their order
 * in the data model stay in definitions.ts. A tab without a layout is shown as
 * a plain vertical form; a placed field that no layout cell names (for example
 * a retired field that still has history on the visit) is shown after the boxes.
 */

export type BoxTone = "plain" | "red" | "blue" | "none";

export interface LayoutCell {
  code: string;
  /** Visible label when it differs from the field label (e.g. SonoSoft's second "How long?"). */
  label?: string;
  /** The field sits right after the previous one with no visible label of its own. */
  hideLabel?: boolean;
  /** Relative width inside its row. */
  size?: "xs" | "s" | "m" | "l" | "full";
  /** Larger text area / list box, like SonoSoft's tall fields. */
  tall?: boolean;
}

export interface LayoutRow {
  cells: LayoutCell[];
}

/** Fills the next empty row of a list of single-select row fields (AP1/AP2). */
export interface RowFiller {
  /** Button/selector label, SonoSoft wording. */
  label: string;
  /** Row field codes in order; the first empty one receives the choice. */
  codes: string[];
}

export interface LayoutBox {
  id: string;
  title?: string;
  tone: BoxTone;
  rows: LayoutRow[];
  filler?: RowFiller;
  /** Caption above the box's rows, e.g. SonoSoft's "Click to Add". */
  caption?: string;
}

export interface SectionLayout {
  boxes: LayoutBox[];
}

const row = (...cells: LayoutCell[]): LayoutRow => ({ cells });
const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}_${from + i}`);

/** docs/reference/sonosoft/tabs/workup-01-subj-complaints-habits.jpg */
const SUBJ: SectionLayout = {
  boxes: [
    {
      id: "visit",
      tone: "none",
      rows: [row({ code: "reason_for_visit", size: "l" }, { code: "problem_list", size: "m" })],
    },
    {
      id: "complaints",
      tone: "plain",
      caption: "Add Chief Complaints with characteristics and Associated conditions",
      rows: [
        row({ code: "chief_complaints", size: "l", tall: true }, { code: "characteristics", size: "m", tall: true }),
        row(
          { code: "duration", size: "s" },
          { code: "symptoms_worse", size: "s" },
          { code: "progression", hideLabel: true, size: "m" },
        ),
        row({ code: "daily_activity_impact", size: "full", tall: true }),
        row({ code: "chest_comments", size: "full", tall: true }),
        row({ code: "comments", size: "full" }),
      ],
    },
    {
      id: "factors",
      tone: "red",
      rows: [row({ code: "aggravating_factors", size: "m" }, { code: "relieving_factors", size: "m" })],
    },
    {
      id: "therapy",
      tone: "blue",
      rows: [
        row(
          { code: "previous_conservative_therapy", size: "l" },
          { code: "previous_conservative_therapy_duration", label: "How long?", size: "s" },
          { code: "family_history_vv", size: "s" },
        ),
      ],
    },
    {
      id: "habits",
      title: "Habits",
      tone: "plain",
      rows: [row({ code: "alcohol", size: "s" }, { code: "exercise", size: "s" }, { code: "tobacco", size: "s" })],
    },
    {
      id: "medications",
      tone: "plain",
      rows: [
        row({ code: "pain_meds", size: "l" }),
        row({ code: "current_meds", size: "l", tall: true }, { code: "current_meds_none", size: "xs" }),
        row({ code: "allergies", size: "l", tall: true }, { code: "allergies_no_known", size: "xs" }),
      ],
    },
  ],
};

/** docs/reference/sonosoft/tabs/workup-03-past-medical-hx.jpg */
const PAST_MEDICAL_HX: SectionLayout = {
  boxes: [
    {
      id: "history",
      tone: "none",
      caption: "Click to Add",
      rows: [
        row({ code: "past_medical_history", size: "full", tall: true }),
        row({ code: "family_history", size: "l", tall: true }, { code: "family_history_unknown", size: "xs" }),
        row({ code: "prior_test_results", size: "full", tall: true }),
        row({ code: "past_medical_additional_comments", size: "full" }),
      ],
    },
    {
      id: "surgical",
      tone: "blue",
      rows: [row({ code: "surgical_history", size: "full" }), row({ code: "female_statement", size: "full" })],
    },
  ],
};

/** docs/reference/sonosoft/tabs/workup-09-assessment-plan-plus.jpg */
const ASSESSMENT_PLAN: SectionLayout = {
  boxes: [
    {
      id: "impression",
      title: "Impression",
      tone: "blue",
      filler: { label: "Select Impressions", codes: range("impression", 1, 8) },
      rows: [
        row({ code: "impression_list_style", size: "s" }),
        ...[1, 2, 3, 4].map((i) =>
          row(
            { code: `impression_${i}`, label: `${i}:`, size: "m" },
            { code: `impression_${i + 4}`, label: `${i + 4}:`, size: "m" },
          ),
        ),
        row({ code: "impr_for_init_venous_interp", size: "full" }),
      ],
    },
    {
      id: "recommendations",
      title: "Recommendations",
      tone: "blue",
      filler: { label: "Select Recomendations", codes: range("recommendation", 1, 8) },
      rows: range("recommendation", 1, 8).map((code, i) => row({ code, label: `${i + 1}:`, size: "full" })),
    },
    {
      id: "stockings",
      title: "Stockings detail",
      tone: "blue",
      rows: [
        row(
          { code: "stockings_type", size: "s" },
          { code: "stockings_compression", size: "s" },
          { code: "stockings_mid_thigh", label: "SIZE - Mid Thigh", size: "xs" },
          { code: "stockings_mid_calf", size: "xs" },
          { code: "stockings_mid_ankle", size: "xs" },
        ),
        row(
          { code: "stockings_gender", size: "s" },
          { code: "stockings_color", size: "s" },
          { code: "stockings_floor_to_gf", label: "DISTANCE - Floor To GF", size: "xs" },
          { code: "stockings_floor_to_knee", size: "xs" },
        ),
      ],
    },
    {
      id: "comments",
      tone: "none",
      rows: [row({ code: "assessment_additional_comments", size: "full" })],
    },
  ],
};

export const SECTION_LAYOUTS: Record<string, SectionLayout> = {
  subj_complaints_habits: SUBJ,
  past_medical_hx: PAST_MEDICAL_HX,
  assessment_plan: ASSESSMENT_PLAN,
};

/** Every field code a layout places, in layout order. */
export function layoutFieldCodes(layout: SectionLayout): string[] {
  return layout.boxes.flatMap((b) => b.rows.flatMap((r) => r.cells.map((c) => c.code)));
}
