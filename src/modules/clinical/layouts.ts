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
  /** Radio choices in one line without a frame (SonoSoft's "Patient feels"). */
  inline?: boolean;
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

/** SonoSoft's small "Clear" button next to a row: empties that field (a new, audited version). */
export interface ClearItem {
  kind: "clear";
  rect: Rect;
  forCode: string;
}

export type LayoutItem = FieldItem | LabelItem | OpenerItem | BoxItem | FillerItem | ClearItem;

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

const BLUE_BOX = "#3d4fa0";
const sub = (text: string, x: number, y: number) => l(text, x, y, { bold: true, color: "blue", size: 9.5 });

/** docs/reference/sonosoft/tabs/treatment-02-laser-ablation.jpg (R3, ADR-031). */
const LASER_ABLATION: SectionLayout = {
  width: 790,
  height: 425,
  origin: { x: 0, y: 292 },
  background: "#f0f0f0",
  items: [
    l("Laser Ablation", 277, 305, { title: true }),
    l("Treated Vessel:", 62, 330, { w: 90, align: "right", forCode: "laser_vessel" }),
    f("laser_side", r(155, 329, 64, 16)),
    f("laser_vessel", r(226, 329, 163, 16)),
    l("beginning at", 393, 330, { forCode: "laser_start_cm" }),
    f("laser_start_cm", r(446, 329, 33, 16)),
    l("cm. from the junction and terminated at the", 484, 330, { forCode: "laser_terminated_at" }),
    f("laser_terminated_at", r(666, 329, 102, 16)),

    box(r(11, 353, 764, 31), BLUE_BOX),
    l("Ambulatory Phlebectomy?", 47, 360),
    l("Location :", 182, 360, { forCode: "laser_phlebectomy_location" }),
    f("laser_phlebectomy_location", r(226, 359, 282, 16)),
    l("# of incisions:", 514, 360, { forCode: "laser_incisions" }),
    f("laser_incisions", r(573, 359, 39, 16)),
    l("using", 621, 360, { forCode: "laser_phlebectomy_using" }),
    f("laser_phlebectomy_using", r(646, 359, 122, 16)),

    l("Anesthesia", 107, 390, { forCode: "laser_anesthesia" }),
    f("laser_anesthesia", r(155, 389, 434, 16), { bold: true }),
    l("Cleansed with", 609, 390, { forCode: "laser_cleansed_with" }),
    f("laser_cleansed_with", r(668, 389, 100, 16)),
    f("laser_agent_1_amount", r(155, 410, 50, 16)),
    f("laser_agent_1", r(209, 410, 134, 16)),
    f("laser_agent_2_amount", r(359, 410, 50, 16)),
    f("laser_agent_2", r(412, 410, 146, 16)),
    f("laser_agent_3_amount", r(563, 410, 50, 16)),
    f("laser_agent_3", r(617, 410, 151, 16)),

    sub("For Single Pass", 221, 436),
    sub("For duplication and 2nd Pass", 510, 436),
    l("Entry point", 105, 454, { forCode: "laser_entry_point" }),
    f("laser_entry_point", r(155, 453, 93, 16), { bold: true }),
    l("to the", 257, 454, { forCode: "laser_pass1_to" }),
    f("laser_pass1_to", r(284, 453, 118, 16), { bold: true }),
    l("then from the", 411, 454, { forCode: "laser_pass2_from" }),
    f("laser_pass2_from", r(468, 453, 94, 16)),
    l("to the", 570, 454, { forCode: "laser_pass2_to" }),
    f("laser_pass2_to", r(599, 453, 117, 16), { bold: true }),

    box(r(11, 478, 766, 70), BLUE_BOX),
    l("Treatment Parameters:", 19, 484, { w: 130, align: "right", forCode: "laser_parameters" }),
    f("laser_parameters", r(155, 483, 144, 16)),
    l("Treatment was CHANGED at the", 303, 484, { forCode: "laser_changed_at" }),
    f("laser_changed_at", r(436, 483, 62, 16)),
    f("laser_changed_to", r(500, 483, 210, 16)),
    f("laser_changed_value", r(714, 483, 52, 16)),
    l("Total laser energy used was:", 9, 504, { w: 140, align: "right", forCode: "laser_energy_joules" }),
    f("laser_energy_joules", r(155, 503, 73, 16)),
    l("joules for", 232, 504, { forCode: "laser_seconds" }),
    f("laser_seconds", r(279, 503, 51, 16)),
    l("seconds", 336, 504),
    l("Total length of vein treated:", 398, 504, { forCode: "laser_length_treated" }),
    f("laser_length_treated", r(515, 503, 41, 16)),
    l("Average Dia.of Vein:", 588, 504, { forCode: "laser_avg_diameter" }),
    f("laser_avg_diameter", r(676, 503, 34, 16)),
    l("OPTIONAL:", 70, 524, { w: 80, align: "right", forCode: "laser_optional" }),
    f("laser_optional", r(155, 523, 334, 16)),
    f("laser_optional_value", r(493, 523, 40, 16)),
    l("Fluence:", 637, 527, { forCode: "laser_fluence" }),
    f("laser_fluence", r(676, 525, 34, 16)),

    l("Add'l Surgical Comments:", 2, 557, { w: 150, align: "right", color: "red", forCode: "laser_surgical_comments" }),
    f("laser_surgical_comments", r(155, 555, 615, 62)),
    l("Final Comments:", 2, 621, { w: 150, align: "right", color: "red", forCode: "laser_final_comments" }),
    f("laser_final_comments", r(155, 620, 615, 50)),
    f("laser_machine", r(155, 678, 150, 16), { bold: true }),
    l("Please set your Laser Machine as default", 310, 679, { size: 12, forCode: "laser_machine" }),
  ],
};

/** docs/reference/sonosoft/tabs/treatment-09-follow-up-office-visit.jpg (R3, ADR-031). */
const FOLLOW_UP: SectionLayout = {
  width: 790,
  height: 580,
  origin: { x: 0, y: 292 },
  background: "#f0f0f0",
  items: [
    box(r(8, 300, 680, 128)),
    l("Subjective", 15, 305, { underline: true, size: 11.5, forCode: "followup_subjective" }),
    l("Patient feels:", 84, 314),
    f("followup_patient_feels", r(146, 312, 204, 15), { inline: true }),
    f("followup_subjective_statement", r(352, 313, 324, 16)),
    f("followup_subjective", r(148, 337, 528, 86)),

    box(r(8, 431, 680, 115)),
    l("Objective Findings", 17, 439, { underline: true, size: 11.5, forCode: "followup_objective" }),
    f("followup_objective", r(148, 435, 528, 106)),

    box(r(8, 549, 680, 142)),
    l("Assessment", 15, 553, { underline: true, size: 11.5, forCode: "followup_assessment_1" }),
    ...[1, 2, 3].flatMap((i) => {
      const y = [557, 600, 643][i - 1] ?? 557;
      return [
        l(`${i}:`, 136, y, { size: 9, forCode: `followup_assessment_${i}` }),
        f(`followup_assessment_${i}`, r(148, y, 528, i === 3 ? 42 : 39)),
      ];
    }),

    box(r(8, 694, 680, 168)),
    l("Plan", 15, 699, { underline: true, size: 11.5, forCode: "followup_plan_1" }),
    { kind: "filler", label: "Select", rect: r(68, 703, 34, 17), codes: ["followup_plan_1", "followup_plan_2"] },
    l("Plan 1:", 116, 701, { size: 9, forCode: "followup_plan_1" }),
    f("followup_plan_1", r(148, 700, 528, 75)),
    l("Plan 2:", 116, 778, { size: 9, forCode: "followup_plan_2" }),
    f("followup_plan_2", r(148, 778, 528, 75)),
  ],
};

/**
 * docs/reference/sonosoft/tabs/treatment-10-post-evlt-comp-follow-up-part1.jpg and
 * -part2.jpg (R3b, ADR-032). The two screenshots do not show what lies between
 * Cardio and Indications; nothing is invented there, so everything from
 * Indications down is drawn GAP px higher than in SonoSoft.
 */
const POST_EVLT_GAP = 56;
const postEvlt = (): SectionLayout => {
  const up = (y: number) => y - POST_EVLT_GAP;
  const rowLabel = (text: string, y: number, code: string, x = 30, w = 100) =>
    l(text, x, y, { w, align: "right", bold: true, forCode: code });
  const exam = [
    ["Constitution", "exam_constitution", 592],
    ["Eyes", "exam_eyes", 625],
    ["ENMT", "exam_enmt", 659],
    ["Neck", "exam_neck", 692],
    ["Lungs", "exam_lungs", 726],
    ["Cardio", "exam_cardio", 759],
  ] as const;
  return {
    width: 700,
    height: up(1410) - 292 + 12,
    origin: { x: 0, y: 292 },
    background: "#f0f0f0",
    items: [
      box(r(15, 325, 672, up(1410) - 325)),
      l("Height:", 27, 336, { forCode: "vital_height" }),
      f("vital_height", r(61, 334, 28, 18)),
      l("Weight:", 96, 336, { forCode: "vital_weight" }),
      f("vital_weight", r(133, 334, 32, 18)),
      l("Pulse:", 189, 336, { forCode: "vital_pulse" }),
      f("vital_pulse", r(219, 334, 22, 18)),
      l("Bp:", 248, 336, { forCode: "vital_bp" }),
      f("vital_bp", r(266, 334, 52, 18)),
      l("Rhythm:", 329, 336, { forCode: "vital_rhythm" }),
      f("vital_rhythm", r(368, 335, 67, 16)),
      l("Temp:", 443, 336, { forCode: "vital_temp" }),
      f("vital_temp", r(472, 334, 33, 18)),
      l("Respiratory Rate:", 512, 336, { forCode: "vital_respiratory_rate" }),
      f("vital_respiratory_rate", r(593, 334, 20, 18)),
      l("BMI:", 627, 336, { forCode: "vital_bmi" }),
      f("vital_bmi", r(646, 334, 31, 18)),
      box(r(15, 362, 672, 1)),

      l("Subjective", 28, 370, { w: 100, align: "right", bold: true, underline: true, size: 10, forCode: "post_subjective" }),
      f("post_subjective", r(132, 368, 519, 30)),
      l("Objective Findings", 18, 400, { w: 110, align: "right", bold: true, underline: true, size: 10, forCode: "post_objective" }),
      f("post_objective", r(132, 402, 519, 30)),
      rowLabel("Past Medical Hx", 436, "past_medical_history", 17, 110),
      f("past_medical_history", r(132, 436, 519, 30)),
      rowLabel("Current Meds", 469, "current_meds", 17, 110),
      f("current_meds", r(132, 469, 519, 30)),
      rowLabel("Allergies", 502, "allergies", 17, 110),
      f("allergies", r(132, 502, 519, 30)),
      rowLabel("Social Hx", 536, "social_history", 17, 110),
      f("social_history", r(132, 536, 519, 24)),
      box(r(15, 563, 672, 1)),

      l("Physical Exam Findings", 23, 571, { bold: true, underline: true, size: 10 }),
      ...exam.flatMap(([text, code, y]) => [rowLabel(text, y + 1, code), f(code, r(132, y, 519, 30))]),

      l("Indications", 27, up(866), { w: 100, align: "right", bold: true, forCode: "us_indications" }),
      f("us_indications", r(132, up(860), 519, 28)),
      l("Findings", 30, up(893), { w: 100, align: "right", forCode: "us_findings" }),
      f("us_findings", r(132, up(892), 519, 30)),
      l("Impression", 30, up(926), { w: 100, align: "right", forCode: "us_impression" }),
      f("us_impression", r(132, up(925), 519, 16)),
      box(r(15, up(950), 672, 1)),

      l("CEAP:", 89, up(963), { w: 80, align: "right", bold: true, forCode: "ceap" }),
      f("ceap", r(172, up(962), 278, 16)),
      l("VCSS Right:", 89, up(983), { w: 80, align: "right", bold: true, forCode: "vcss_right" }),
      f("vcss_right", r(172, up(982), 278, 16)),
      l("VCSS Left:", 89, up(1003), { w: 80, align: "right", bold: true, forCode: "vcss_left" }),
      f("vcss_left", r(172, up(1002), 278, 16)),
      box(r(15, up(1023), 672, 1)),

      { kind: "filler", label: "Add Impression", rect: r(23, up(1037), 92, 27), codes: ["impression_1", "impression_2", "impression_3", "impression_4"] },
      f("impression_list_style", r(25, up(1082), 80, 43)),
      ...[1, 2, 3, 4].flatMap((i): LayoutItem[] => {
        const y = up(1037 + (i - 1) * 30);
        return [
          { kind: "clear", rect: r(118, y, 32, 15), forCode: `impression_${i}` },
          l(`${i}:`, 161, y + 2, { bold: true, forCode: `impression_${i}` }),
          f(`impression_${i}`, r(172, y, 480, 26)),
        ];
      }),
      l("Impr for Init Venous Interp", 17, up(1157), { w: 150, align: "right", size: 9, forCode: "impr_for_init_venous_interp" }),
      f("impr_for_init_venous_interp", r(172, up(1156), 480, 16)),
      box(r(15, up(1180), 672, 1)),

      { kind: "filler", label: "Add Recomendations", rect: r(23, up(1190), 122, 25), codes: rowCodes("recommendation").slice(0, 5) },
      ...[1, 2, 3, 4, 5].map((i) => f(`recommendation_${i}`, r(172, up(1190 + (i - 1) * 43), 480, 40))),
    ],
  };
};

export const SECTION_LAYOUTS: Record<string, SectionLayout> = {
  subj_complaints_habits: SUBJ,
  past_medical_hx: PAST_MEDICAL_HX,
  assessment_plan: ASSESSMENT_PLAN,
  laser_ablation: LASER_ABLATION,
  follow_up_office_visit: FOLLOW_UP,
  post_evlt_follow_up: postEvlt(),
};

/** Every field code a layout places. */
export function layoutFieldCodes(layout: SectionLayout): string[] {
  return layout.items.flatMap((i) => (i.kind === "field" ? [i.code] : []));
}
