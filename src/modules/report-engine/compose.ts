/**
 * Builds the first draft of a report from the chart (R5, ADR-034), so the
 * doctor does not retype what was recorded. Only values that exist are used,
 * and sentences are assembled with proper spaces and punctuation: an empty
 * field never leaves a broken sentence, an empty bullet or an empty heading
 * (the SonoSoft defects listed in docs/reference/sonosoft/README.md).
 */
import { FIXED_CHOICES, NUMERIC_FIELD_RULES } from "@/modules/clinical/definitions";

export interface ChartValue {
  /** Option labels and visit-only text, joined with ", ". Empty when nothing was recorded. */
  text: string;
  checked: boolean;
}

export interface ComposeInput {
  patient: { firstName: string; lastName: string; sex: "F" | "M" | null; age: number | null };
  values: Record<string, ChartValue | undefined>;
  /** Treatment Plan procedures completed on the visit date. */
  proceduresToday: string[];
}

const text = (v: ChartValue | undefined) => v?.text.trim() ?? "";

function sentence(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (!t) return "";
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
}

const joinSentences = (parts: string[]) => parts.map(sentence).filter(Boolean).join(" ");

/** "a", "a and b", "a, b and c". */
function listJoin(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function lines(values: ComposeInput["values"], prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => text(values[`${prefix}_${i + 1}`]))
    .filter(Boolean)
    .join("\n");
}

export function composeHistory({ patient, values }: ComposeInput): string {
  const who = [
    `${patient.firstName} ${patient.lastName}`.trim(),
    "is a",
    patient.age !== null ? `${patient.age}-year-old` : "",
    patient.sex === "F" ? "female" : patient.sex === "M" ? "male" : "patient",
  ]
    .filter(Boolean)
    .join(" ");
  const reason = text(values.reason_for_visit);
  const complaints = text(values.chief_complaints);
  const assoc = text(values.characteristics);
  const howLong = text(values.duration);
  const complaint = complaints
    ? [`complains of ${complaints}`, assoc ? `associated with ${assoc}` : "", howLong].filter(Boolean).join(", ")
    : "";
  const meds = values.current_meds_none?.checked
    ? "The patient takes no medications"
    : text(values.current_meds)
      ? `Current medications: ${text(values.current_meds)}`
      : "";
  return joinSentences([
    [who, reason ? `who presents for ${reason}` : "", complaint ? `and ${complaint}` : ""].filter(Boolean).join(" "),
    values.symptoms_worse?.checked ? "Symptoms are getting worse over time" : "",
    text(values.progression),
    text(values.daily_activity_impact),
    text(values.previous_conservative_therapy)
      ? [text(values.previous_conservative_therapy), text(values.previous_conservative_therapy_duration)].filter(Boolean).join(", ")
      : "",
    text(values.family_history_vv) ? `Family history of varicose veins: ${text(values.family_history_vv)}` : "",
    composeVenousHistory(values),
    meds,
  ]);
}

/** Past Venous Hx tab (ADR-040), in the words of a report. */
const VENOUS_HISTORY: [string, string][] = [
  ["venous_hx_phlebitis", "phlebitis"],
  ["venous_hx_dvt", "DVT"],
  ["venous_hx_pulmonary_embolism", "pulmonary embolism"],
  ["venous_hx_bleeding_from_veins", "bleeding from veins"],
  ["venous_hx_sclerotherapy", "sclerotherapy"],
  ["venous_hx_sonogram", "a previous sonogram"],
  ["venous_hx_prior_vein_surgery", "prior vein surgery"],
  ["venous_hx_hemorrhoids", "hemorrhoids"],
  ["venous_hx_iv_drug_use", "IV drug use"],
  ["venous_hx_aids_hiv_hepatitis", "AIDS/HIV/hepatitis"],
  ["venous_hx_previous_trauma", "previous trauma"],
  ["venous_hx_clotting_disorder", "a clotting disorder"],
];

export function composeVenousHistory(values: ComposeInput["values"]): string {
  const checked = VENOUS_HISTORY.filter(([code]) => values[code]?.checked).map(([, words]) => words);
  return joinSentences([checked.length > 0 ? `Past venous history of ${listJoin(checked)}` : "", text(values.vein_history_narrative)]);
}

export function composePastMedicalHistory({ values }: ComposeInput): string {
  const allergies = values.allergies_no_known?.checked
    ? "no known allergy"
    : text(values.allergies)
      ? `allergies: ${text(values.allergies)}`
      : "";
  return [
    text(values.past_medical_history),
    allergies,
    text(values.surgical_history) ? `surgical history: ${text(values.surgical_history)}` : "",
    values.family_history_unknown?.checked
      ? "family history unknown"
      : text(values.family_history)
        ? `family history: ${text(values.family_history)}`
        : "",
  ]
    .filter(Boolean)
    .join(", ");
}

const EXAM: [string, string][] = [
  ["exam_constitution", "Constitution"],
  ["exam_eyes", "Eyes"],
  ["exam_enmt", "ENMT"],
  ["exam_neck", "Neck"],
  ["exam_lungs", "Lungs"],
  ["exam_cardio", "Cardio"],
];

export function composePhysicalExamination({ values }: ComposeInput): string {
  return joinSentences(EXAM.map(([code, label]) => (text(values[code]) ? `${label}: ${text(values[code])}` : "")));
}

/** The label of a fixed choice ("incompetent"), or "" when nothing was chosen. */
function choiceLabel(values: ComposeInput["values"], code: string): string {
  const v = text(values[code]);
  return (FIXED_CHOICES[code]?.find((c) => c.value === v)?.label ?? v).toLowerCase();
}

/** One leg of the Initial US Exam (ADR-041) as a paragraph; "" when nothing was recorded for it. */
export function composeUltrasoundLeg(values: ComposeInput["values"], side: "r" | "l"): string {
  const code = (name: string) => `ius_${side}_${name}`;
  const t = (name: string) => text(values[code(name)]);
  const on = (name: string) => values[code(name)]?.checked === true;
  const deep = [
    ["deep_cfv_reflux", "common femoral"],
    ["deep_fv_reflux", "femoral"],
    ["deep_pop_reflux", "popliteal"],
  ].flatMap(([name, vein]) => (on(name!) ? [vein!] : []));
  const vein = (name: string, status: string, details: string[]) => {
    const d = details.filter(Boolean);
    if (!status && d.length === 0) return "";
    return `${name}${status ? ` ${status}` : ""}${d.length ? `: ${d.join(", ")}` : ""}`;
  };
  const kneeUnit = NUMERIC_FIELD_RULES[code("gsv_size_knee")]?.unit ?? "";
  const accessories = [on("accessory_anterior") ? "anterior" : "", on("accessory_posterior") ? "posterior" : ""].filter(Boolean);
  const perforators = [
    ["perf_thigh", "thigh"],
    ["perf_proximal_calf", "proximal calf"],
    ["perf_mid_calf", "mid calf"],
    ["perf_distal_calf", "distal calf"],
    ["perf_ankle", "ankle"],
  ].flatMap(([name, level]) => (on(name!) ? [level!] : []));
  const body = joinSentences([
    deep.length > 0 ? `Deep venous reflux in the ${listJoin(deep)} ${deep.length === 1 ? "vein" : "veins"}` : "",
    vein("GSV", choiceLabel(values, code("gsv_status")), [
      t("gsv_size_sfj") ? `size at the femoral junction ${t("gsv_size_sfj")}` : "",
      t("gsv_size_knee") ? `size at the knee ${t("gsv_size_knee")} ${kneeUnit}`.trim() : "",
      t("gsv_tortuous") ? t("gsv_tortuous").toLowerCase() : "",
      t("gsv_reflux_time") ? `reflux time ${t("gsv_reflux_time")}` : "",
      t("gsv_reflux_extent") ? `distal extent of reflux ${t("gsv_reflux_extent")}` : "",
    ]),
    vein("SSV", choiceLabel(values, code("ssv_status")), [
      t("ssv_size_spj") ? `size at the popliteal junction ${t("ssv_size_spj")}` : "",
      t("ssv_reflux_time") ? `reflux time ${t("ssv_reflux_time")}` : "",
    ]),
    accessories.length > 0
      ? `Incompetent ${listJoin(accessories)} accessory saphenous ${accessories.length === 1 ? "vein" : "veins"}`
      : "",
    perforators.length > 0 ? `Incompetent ${perforators.length === 1 ? "perforator" : "perforators"}: ${perforators.join(", ")}` : "",
    t("perforators_statement"),
  ]);
  return body ? `${side === "r" ? "Right" : "Left"} leg: ${body}` : "";
}

/** The rest of the Initial US Exam: measurements, findings, impression and the DVT statement. */
export function composeUltrasoundGeneral(values: ComposeInput["values"]): string {
  const dvt = text(values.ius_dvt);
  return joinSentences([
    text(values.ius_additional_measurements) ? `Additional measurements: ${text(values.ius_additional_measurements)}` : "",
    text(values.ius_addl_findings_1),
    text(values.ius_addl_findings_2),
    text(values.ius_addl_findings_3),
    // SonoSoft's sentence: "There [is NO | is] evidence of DVT found during this examination."
    dvt ? `There ${FIXED_CHOICES.ius_dvt?.find((c) => c.value === dvt)?.label ?? dvt} evidence of DVT found during this examination` : "",
    text(values.ius_dvt_location),
    text(values.ius_impression) ? `Ultrasound impression: ${text(values.ius_impression)}` : "",
  ]);
}

/** Initial US Exam (right leg, left leg, general) then the Post EVLT ultrasound, one paragraph each. */
export function composeUltrasound({ values }: ComposeInput): string {
  return [
    composeUltrasoundLeg(values, "r"),
    composeUltrasoundLeg(values, "l"),
    composeUltrasoundGeneral(values),
    composePostEvltUltrasound(values),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function composePostEvltUltrasound(values: ComposeInput["values"]): string {
  return joinSentences([
    text(values.us_indications) ? `Indications: ${text(values.us_indications)}` : "",
    text(values.us_findings),
    text(values.us_impression),
    text(values.ceap) ? `CEAP: ${text(values.ceap)}` : "",
    text(values.vcss_right) ? `VCSS Right: ${text(values.vcss_right)}` : "",
    text(values.vcss_left) ? `VCSS Left: ${text(values.vcss_left)}` : "",
  ]);
}

export function composeNarrative(input: ComposeInput): string {
  const procedures = input.proceduresToday.map((p) => p.trim()).filter(Boolean);
  return joinSentences([
    procedures.length > 0 ? `Procedure performed today: ${procedures.join("; ")}` : "",
    lines(input.values, "followup_plan", 2).replace(/\n/g, ". "),
  ]);
}

/** First draft of every section of a template (keys as in templates.ts). */
export function composeSections(input: ComposeInput): Record<string, string> {
  return {
    narrative: composeNarrative(input),
    history: composeHistory(input),
    past_medical_history: composePastMedicalHistory(input),
    physical_examination: composePhysicalExamination(input),
    ultrasound_findings: composeUltrasound(input),
    impression: lines(input.values, "impression", 8),
    recommendations: lines(input.values, "recommendation", 8),
  };
}
