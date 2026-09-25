/**
 * Builds the first draft of a report from the chart (R5, ADR-034), so the
 * doctor does not retype what was recorded. Only values that exist are used,
 * and sentences are assembled with proper spaces and punctuation: an empty
 * field never leaves a broken sentence, an empty bullet or an empty heading
 * (the SonoSoft defects listed in docs/reference/sonosoft/README.md).
 */

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
    meds,
  ]);
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

export function composeUltrasound({ values }: ComposeInput): string {
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
