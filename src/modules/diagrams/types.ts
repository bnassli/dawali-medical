/**
 * Diagram types (R4, ADR-033). Each names its IMMUTABLE base template, served
 * as a static, non-patient asset. The drawing is stored as strokes in the
 * template's own coordinate space, so a version can be re-opened and edited.
 */
export const DIAGRAM_TYPES = {
  leg: {
    label: "Leg Diagram",
    button: "Create Leg Diagram",
    fileLabel: "LegDiagram",
    template: "/diagram-templates/leg.svg",
    width: 800,
    height: 600,
  },
  vein: {
    label: "Vein Diagram",
    button: "Create Vein Diagram",
    fileLabel: "VeinDiagram",
    template: "/diagram-templates/vein.svg",
    width: 900,
    height: 600,
  },
} as const;

export type DiagramType = keyof typeof DIAGRAM_TYPES;

export function isDiagramType(v: string): v is DiagramType {
  return v === "leg" || v === "vein";
}

export const MAX_DIAGRAM_PNG_BYTES = 5 * 1024 * 1024;
export const MAX_DIAGRAM_STROKES = 5000;
export const MAX_DIAGRAM_POINTS = 400_000;
