/**
 * Report templates (R5, ADR-034) are DATA: sections in order, which diagram
 * goes where, and which sections are lists. The engine (compose, preview,
 * docx) reads these definitions, so doctor-specific templates can be added
 * later as new entries without changing the engine.
 */
import type { DiagramType } from "@/modules/diagrams/types";

export interface ReportSectionDef {
  key: string;
  /** Printed in bold before the text ("HISTORY:"); null = plain paragraph. */
  heading: string | null;
  /** "list": one bullet (or number) per line. */
  kind: "text" | "list";
  /** Start a new page before this section (Template 2 page 2). */
  pageBreakBefore?: boolean;
  /** Diagram printed right after this section. */
  diagramAfter?: DiagramType;
}

export interface ReportTemplate {
  code: string;
  name: string;
  sections: ReportSectionDef[];
}

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    code: "short_procedure",
    name: "Template 1 — Short procedure report",
    sections: [{ key: "narrative", heading: null, kind: "text", diagramAfter: "leg" }],
  },
  {
    code: "venous_evaluation",
    name: "Template 2 — Initial Venous Consultation / Vascular Evaluation",
    sections: [
      { key: "history", heading: "HISTORY:", kind: "text" },
      { key: "past_medical_history", heading: "PAST MEDICAL HISTORY:", kind: "text" },
      { key: "physical_examination", heading: "PHYSICAL EXAMINATION:", kind: "text", diagramAfter: "leg" },
      {
        key: "ultrasound_findings",
        heading: "ULTRASOUND FINDINGS:",
        kind: "text",
        pageBreakBefore: true,
        diagramAfter: "vein",
      },
      { key: "impression", heading: "IMPRESSION:", kind: "list" },
      { key: "recommendations", heading: "RECOMMENDATIONS:", kind: "list" },
    ],
  },
];

export function reportTemplate(code: string): ReportTemplate | undefined {
  return REPORT_TEMPLATES.find((t) => t.code === code);
}

/** Diagram types a template prints; a report cannot be finalized without them. */
export function requiredDiagrams(template: ReportTemplate): DiagramType[] {
  return template.sections.flatMap((s) => (s.diagramAfter ? [s.diagramAfter] : []));
}

export const MAX_SECTION_CHARS = 20_000;
