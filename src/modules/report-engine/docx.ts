import { AlignmentType, Document, ImageRun, Packer, PageBreak, Paragraph, TextRun } from "docx";
import { DIAGRAM_TYPES, type DiagramType } from "@/modules/diagrams/types";
import type { ReportTemplate } from "./templates";

/**
 * Renders a report as an editable Word document (R5, ADR-034): Times New Roman
 * like the clinic's SonoSoft reports, clinic header, Patient / File Number /
 * Date, the template's sections, the chosen diagram images and the doctor's
 * signature line. Empty sections are left out entirely (no empty headings).
 */
export interface DocxInput {
  template: ReportTemplate;
  sections: Record<string, string>;
  listStyle: "bullets" | "numbers";
  patientName: string;
  fileNumber: string | null;
  /** dd/mm/yyyy — one unambiguous format (README: SonoSoft mixed m/d and d/m). */
  date: string;
  doctorName: string;
  diagrams: Partial<Record<DiagramType, Uint8Array>>;
}

const FONT = "Times New Roman";
const run = (text: string, opts: { bold?: boolean; size?: number } = {}) =>
  new TextRun({ text, font: FONT, size: (opts.size ?? 12) * 2, bold: opts.bold });

function labelled(label: string, value: string) {
  return new Paragraph({ children: [run(`${label} `, { bold: true }), run(value)] });
}

export async function buildReportDocx(input: DocxInput): Promise<Uint8Array> {
  const children: Paragraph[] = [
    // Clinic header. The logo image is added when the clinic supplies it (ADR-034).
    new Paragraph({ children: [run("Dawali Clinic", { bold: true, size: 20 })] }),
    new Paragraph({ children: [run("عيادات دوالي", { size: 16 })], spacing: { after: 300 } }),
    labelled("Patient:", input.patientName),
    ...(input.fileNumber ? [labelled("File Number:", input.fileNumber)] : []),
    labelled("Date:", input.date),
    new Paragraph({ children: [] }),
  ];

  for (const section of input.template.sections) {
    const body = (input.sections[section.key] ?? "").trim();
    if (section.pageBreakBefore) children.push(new Paragraph({ children: [new PageBreak()] }));
    if (body) {
      if (section.kind === "list") {
        if (section.heading) children.push(new Paragraph({ children: [run(section.heading, { bold: true })] }));
        body
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .forEach((line, i) =>
            children.push(
              new Paragraph({
                indent: { left: 720, hanging: 360 },
                children: [run(input.listStyle === "numbers" ? `${i + 1}.\t${line}` : `•\t${line}`)],
              }),
            ),
          );
      } else {
        const paragraphs = body.split(/\n{2,}/);
        paragraphs.forEach((p, i) =>
          children.push(
            new Paragraph({
              spacing: { after: 200 },
              children: [
                ...(i === 0 && section.heading ? [run(`${section.heading} `, { bold: true })] : []),
                run(p.replace(/\n/g, " ")),
              ],
            }),
          ),
        );
      }
    }
    const diagramType = section.diagramAfter;
    const image = diagramType ? input.diagrams[diagramType] : undefined;
    if (diagramType && image) {
      const spec = DIAGRAM_TYPES[diagramType];
      const width = 440;
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              type: "png",
              data: image,
              transformation: { width, height: Math.round((width * spec.height) / spec.width) },
            }),
          ],
        }),
      );
    }
  }

  children.push(new Paragraph({ children: [] }), new Paragraph({ children: [run(input.doctorName, { bold: true })] }));

  const doc = new Document({
    creator: "Dawali Medical",
    title: `${input.template.name} — ${input.patientName}`,
    sections: [{ children }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}
