/**
 * Pixel layout of each clinical tab, measured from the SonoSoft reference
 * screens (docs/reference/sonosoft/tabs/, Product Owner decision 2026-09-25:
 * the screens must look like SonoSoft, ADR-029). Coordinates are SonoSoft form
 * pixels measured on the reference screenshots scaled to a 1000 px wide window;
 * `origin` is subtracted so a tab starts at (0, 0). The page scales the whole
 * form uniformly, so proportions stay exact.
 *
 * Items are listed in the order of the tab's fields (definitions.ts), which is
 * also the keyboard (Tab) order.
 *
 * Presentation only: which fields exist, their types and order stay in
 * definitions.ts. A placed field that no layout item names (for example a
 * retired field that still has history on the visit) is shown under the form.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TextColor = "red" | "blue" | "navy";

export interface FieldItem {
  kind: "field";
  code: string;
  rect: Rect;
  /** Font size in form pixels (default 10). */
  size?: number;
  bold?: boolean;
  /** White input (SonoSoft's measurement boxes) instead of the grey fill. */
  white?: boolean;
  /** Grey text shown inside an empty control (e.g. "associated with"). */
  placeholder?: string;
  /** false = no drop-down arrow; the list opens from SonoSoft's button next to it. */
  arrow?: boolean;
  /** Multiselect shown only as its opener button (SonoSoft's "Problem List"). */
  buttonOnly?: { text: string; color?: TextColor };
}

export interface LabelItem {
  kind: "label";
  text: string;
  x: number;
  y: number;
  /** Width of the text block; required for right or centre alignment and wrapping. */
  w?: number;
  align?: "left" | "right" | "center";
  color?: TextColor;
  bold?: boolean;
  underline?: boolean;
  size?: number;
  /** Section title style (bold, underlined, navy, 12 px). */
  title?: boolean;
  /** Clicking the label focuses / opens this field. */
  forCode?: string;
}

/** SonoSoft's white push buttons that open a field's list ("Current Meds", "Past Medical Hx"). */
export interface OpenerItem {
  kind: "opener";
  text: string;
  rect: Rect;
  forCode: string;
  color?: TextColor;
  bold?: boolean;
  size?: number;
}

export interface BoxItem {
  kind: "box";
  rect: Rect;
  color?: string;
}

/** "Select Impressions": puts the chosen option into the first empty row field. */
export interface FillerItem {
  kind: "filler";
  label: string;
  rect: Rect;
  codes: string[];
}

export type LayoutItem = FieldItem | LabelItem | OpenerItem | BoxItem | FillerItem;

export interface SectionLayout {
  width: number;
  height: number;
  origin: { x: number; y: number };
  background: string;
  items: LayoutItem[];
}

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const f = (code: string, rect: Rect, extra: Partial<FieldItem> = {}): FieldItem => ({
  kind: "field",
  code,
  rect,
  ...extra,
});
const l = (text: string, x: number, y: number, extra: Partial<LabelItem> = {}): LabelItem => ({
  kind: "label",
  text,
  x,
  y,
  ...extra,
});
const box = (rect: Rect, color?: string): BoxItem => ({ kind: "box", rect, color });
const opener = (text: string, rect: Rect, forCode: string, extra: Partial<OpenerItem> = {}): OpenerItem => ({
  kind: "opener",
  text,
  rect,
  forCode,
  bold: true,
  ...extra,
});

const RED_BOX = "#c62828";
const LIGHT_BLUE_BOX = "#8ea1d3";
const NAVY_BOX = "#2d3f8f";

/** docs/reference/sonosoft/tabs/workup-01-subj-complaints-habits.jpg */
const SUBJ: SectionLayout = {
  width: 790,
  height: 500,
  origin: { x: 0, y: 292 },
  background: "#ffffff",
  items: [
    l("Reason for visit", 95, 309, { size: 11, forCode: "reason_for_visit" }),
    f("reason_for_visit", r(180, 308, 381, 16)),
    f("problem_list", r(5, 336, 85, 21), { buttonOnly: { text: "Problem List", color: "red" } }),

    box(r(94, 329, 686, 195)),
    opener("Add Chief Complaints with characteristics and Associated conditions", r(172, 338, 496, 16), "chief_complaints", {
      size: 9,
    }),
    f("chief_complaints", r(120, 360, 363, 31)),
    f("characteristics", r(483, 360, 246, 31), { size: 9, placeholder: "associated with" }),
    l("How long?", 120, 396, { w: 70, align: "right", forCode: "duration" }),
    f("duration", r(194, 395, 141, 16), { size: 9 }),
    l("Symptoms getting worse over time?", 339, 396, { forCode: "symptoms_worse" }),
    f("symptoms_worse", r(487, 398, 11, 11)),
    f("progression", r(503, 395, 226, 16)),
    l("Affects daily living activities?", 100, 416, { w: 73, align: "right", forCode: "daily_activity_impact" }),
    f("daily_activity_impact", r(194, 414, 535, 31)),
    l("Chest comments", 110, 466, { w: 82, align: "right", color: "red", forCode: "chest_comments" }),
    f("chest_comments", r(194, 463, 535, 31)),
    l("Comment", 110, 503, { w: 82, align: "right", color: "red", forCode: "comments" }),
    f("comments", r(194, 500, 535, 16)),

    box(r(94, 526, 686, 41), RED_BOX),
    l("Aggravating Factors", 224, 530, { bold: true, underline: true, forCode: "aggravating_factors" }),
    l("Relieving Factors", 537, 530, { bold: true, underline: true, forCode: "relieving_factors" }),
    f("aggravating_factors", r(120, 546, 262, 16), { size: 9 }),
    f("relieving_factors", r(382, 546, 347, 16), { size: 9 }),

    box(r(94, 569, 686, 29), LIGHT_BLUE_BOX),
    l("Previous\nconservative therapy", 100, 570, { w: 94, align: "right", forCode: "previous_conservative_therapy" }),
    f("previous_conservative_therapy", r(197, 573, 245, 16), { size: 9 }),
    l("How long?", 448, 574, { forCode: "previous_conservative_therapy_duration" }),
    f("previous_conservative_therapy_duration", r(494, 573, 94, 16)),
    l("Family history of VV?", 594, 574, { forCode: "family_history_vv" }),
    f("family_history_vv", r(682, 573, 47, 16), { size: 9 }),

    box(r(94, 600, 686, 49)),
    l("Habits", 112, 607, { bold: true, underline: true }),
    l("Alcohol", 165, 607, { forCode: "alcohol" }),
    f("alcohol", r(198, 606, 131, 16)),
    l("Exercise", 335, 607, { forCode: "exercise" }),
    f("exercise", r(372, 606, 148, 16)),
    l("Tobacco use", 527, 607, { forCode: "tobacco" }),
    f("tobacco", r(580, 606, 139, 16)),

    box(r(94, 657, 686, 125)),
    l("Pain Meds for CC", 100, 666, { w: 95, align: "right", forCode: "pain_meds" }),
    f("pain_meds", r(198, 664, 299, 16)),
    opener("Current Meds", r(111, 684, 83, 15), "current_meds", { size: 9 }),
    f("current_meds", r(198, 684, 575, 44), { bold: true, size: 9.5, arrow: false }),
    f("current_meds_none", r(128, 708, 11, 11)),
    l("None", 141, 707, { forCode: "current_meds_none" }),
    opener("Allergies", r(111, 731, 83, 15), "allergies", { size: 9 }),
    f("allergies", r(198, 731, 575, 44), { bold: true, size: 9.5 }),
    f("allergies_no_known", r(128, 753, 11, 11)),
    l("No known", 141, 752, { forCode: "allergies_no_known" }),
  ],
};

/** docs/reference/sonosoft/tabs/workup-03-past-medical-hx.jpg */
const PAST_MEDICAL_HX: SectionLayout = {
  width: 790,
  height: 315,
  origin: { x: 0, y: 292 },
  background: "#f0f0f0",
  items: [
    l("Click to Add", 29, 299),
    opener("Past Medical Hx", r(10, 317, 91, 19), "past_medical_history"),
    f("past_medical_history", r(105, 315, 546, 39), { bold: true, size: 9, arrow: false }),
    opener("Family Medical Hx", r(10, 357, 91, 19), "family_history"),
    f("family_history", r(105, 355, 546, 42), { bold: true, size: 9, arrow: false }),
    f("family_history_unknown", r(15, 381, 11, 11)),
    l("Unknown", 28, 380, { forCode: "family_history_unknown" }),
    opener("Prior Test Results", r(10, 401, 89, 19), "prior_test_results"),
    f("prior_test_results", r(105, 400, 546, 110)),
    l("Additional\nComments", 43, 513, { w: 60, align: "right", color: "red", forCode: "past_medical_additional_comments" }),
    f("past_medical_additional_comments", r(105, 513, 546, 28)),

    box(r(105, 546, 546, 49), "#3d4fa0"),
    opener("Surgical Hx", r(110, 553, 59, 16), "surgical_history", { size: 8.5 }),
    f("surgical_history", r(171, 552, 476, 18), { arrow: false }),
    l("If FEMALE select the appropriate statement; otherwise disregard", 201, 572, {
      size: 9,
      forCode: "female_statement",
    }),
    f("female_statement", r(465, 572, 182, 16)),
  ],
};

const impressionRows = (): LayoutItem[] =>
  [1, 2, 3, 4].flatMap((i) => {
    const y = 328 + (i - 1) * 30;
    return [
      l(`${i}:`, 172, y + 4, { color: "red", forCode: `impression_${i}` }),
      f(`impression_${i}`, r(185, y, 261, 26)),
      l(`${i + 4}:`, 481, y + 4, { color: "red", forCode: `impression_${i + 4}` }),
      f(`impression_${i + 4}`, r(493, y, 253, 26)),
    ];
  });

const recommendationRows = (): LayoutItem[] =>
  [1, 2, 3, 4, 5, 6, 7, 8].flatMap((i) => {
    const y = 483 + (i - 1) * 30;
    return [
      l(`${i}:`, 172, y + 4, { color: "red", forCode: `recommendation_${i}` }),
      f(`recommendation_${i}`, r(185, y, 561, 26)),
    ];
  });

const rowCodes = (prefix: string) => [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `${prefix}_${i}`);

/** docs/reference/sonosoft/tabs/workup-09-assessment-plan-plus.jpg */
const ASSESSMENT_PLAN: SectionLayout = {
  width: 790,
  height: 545,
  origin: { x: 0, y: 292 },
  background: "#f0f0f0",
  items: [
    box(r(23, 322, 737, 151), NAVY_BOX),
    l("Impression", 35, 327, { title: true }),
    f("impression_list_style", r(40, 348, 80, 41)),
    { kind: "filler", label: "Select\nImpressions", rect: r(33, 397, 99, 45), codes: rowCodes("impression") },
    ...impressionRows(),
    l("Impr for Init Venous Interp", 23, 450, {
      w: 160,
      align: "right",
      color: "red",
      size: 9,
      forCode: "impr_for_init_venous_interp",
    }),
    f("impr_for_init_venous_interp", r(185, 449, 561, 16)),

    box(r(23, 473, 737, 250), NAVY_BOX),
    l("Recommendations", 30, 487, { title: true }),
    {
      kind: "filler",
      label: "Select\nRecomendations",
      rect: r(33, 523, 99, 45),
      codes: rowCodes("recommendation"),
    },
    ...recommendationRows(),

    box(r(26, 730, 734, 47), NAVY_BOX),
    l("Stockings detail", 37, 740, { title: true }),
    l("Type:", 180, 736, { bold: true, size: 9, forCode: "stockings_type" }),
    f("stockings_type", r(208, 735, 82, 16)),
    l("Compression:", 294, 736, { bold: true, size: 9, forCode: "stockings_compression" }),
    f("stockings_compression", r(359, 735, 81, 16)),
    l("Gender:", 167, 756, { bold: true, size: 9, forCode: "stockings_gender" }),
    f("stockings_gender", r(208, 755, 82, 16)),
    l("Color:", 327, 756, { bold: true, size: 9, forCode: "stockings_color" }),
    f("stockings_color", r(359, 755, 81, 16)),
    box(r(445, 731, 1, 46), NAVY_BOX),
    l("SIZE - Mid Thigh:", 453, 733, { bold: true, size: 9, forCode: "stockings_mid_thigh" }),
    f("stockings_mid_thigh", r(530, 732, 25, 17), { white: true }),
    l("Mid Calf:", 561, 733, { bold: true, size: 9, forCode: "stockings_mid_calf" }),
    f("stockings_mid_calf", r(604, 732, 25, 17), { white: true }),
    l("Mid Ankle:", 638, 733, { bold: true, size: 9, forCode: "stockings_mid_ankle" }),
    f("stockings_mid_ankle", r(689, 732, 25, 17), { white: true }),
    l("DISTANCE - Floor To GF:", 453, 752, { bold: true, size: 9, forCode: "stockings_floor_to_gf" }),
    f("stockings_floor_to_gf", r(564, 752, 24, 16), { white: true }),
    l("Floor To Knee", 595, 752, { bold: true, size: 9, forCode: "stockings_floor_to_knee" }),
    f("stockings_floor_to_knee", r(660, 752, 25, 16), { white: true }),

    // Below the part visible on the reference screenshot (scrolled in SonoSoft).
    l("Additional Comments", 23, 790, {
      w: 160,
      align: "right",
      color: "red",
      forCode: "assessment_additional_comments",
    }),
    f("assessment_additional_comments", r(185, 786, 561, 40)),
  ],
};

/**
 * docs/reference/sonosoft/tabs/treatment-01-treatment-plan.jpg (R2, ADR-030).
 * One line per plan row, 20 px apart; `rows` = saved rows + empty rows. The
 * cell codes are `${column}__${row}` (see treatment-plan.ts). "Cancelled" is
 * not in SonoSoft (PO decision: rows are cancelled, never deleted).
 */
export function treatmentPlanLayout(rows: number): SectionLayout {
  const items: LayoutItem[] = [
    l("Scheduled", 14, 309, { bold: true, underline: true, size: 10 }),
    l("Completed", 88, 309, { bold: true, underline: true, size: 10 }),
    l("Recommended Treatment/Procedures in the order to be received", 166, 309, {
      bold: true,
      underline: true,
      size: 10,
    }),
    l("Approval/Status/Comments", 577, 309, { bold: true, underline: true, size: 10, color: "navy" }),
    l("Cancelled", 786, 309, { bold: true, underline: true, size: 9 }),
  ];
  for (let i = 1; i <= rows; i++) {
    const y = 336 + (i - 1) * 20;
    items.push(
      f(`treatment_scheduled__${i}`, r(12, y, 58, 16), { bold: true, size: 9.5 }),
      f(`treatment_completed__${i}`, r(89, y, 57, 16), { bold: true, size: 9.5 }),
      f(`treatment_procedure__${i}`, r(165, y, 347, 16), { bold: true, size: 9.5 }),
      f(`treatment_status__${i}`, r(519, y, 261, 16), { bold: true, size: 9.5 }),
      f(`treatment_cancelled__${i}`, r(806, y + 2, 11, 11)),
    );
  }
  return {
    width: 840,
    height: 336 + rows * 20 - 292 + 12,
    origin: { x: 0, y: 292 },
    background: "#f0f0f0",
    items,
  };
}

export const SECTION_LAYOUTS: Record<string, SectionLayout> = {
  subj_complaints_habits: SUBJ,
  past_medical_hx: PAST_MEDICAL_HX,
  assessment_plan: ASSESSMENT_PLAN,
};

/** Every field code a layout places. */
export function layoutFieldCodes(layout: SectionLayout): string[] {
  return layout.items.flatMap((i) => (i.kind === "field" ? [i.code] : []));
}
