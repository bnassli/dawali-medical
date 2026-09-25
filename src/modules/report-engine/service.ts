import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/client";
import {
  clinicalEntries,
  clinicalFieldDefinitions,
  clinicalOptions,
  diagrams,
  diagramVersions,
  patientExternalIds,
  patientFiles,
  patients,
  reports,
  reportVersions,
  treatmentPlanEntries,
  treatmentPlanItems,
  users,
  visits,
  type ReportContent,
} from "@/db/schema";
import { ageOn, todayIn } from "@/lib/age";
import type { FileStorage } from "@/lib/file-storage";
import { writeAudit } from "@/modules/audit/service";
import { isUniqueViolation, pgErrorField, VisitNotFoundError, VisitNotOpenError } from "@/modules/clinical/service";
import type { DiagramType } from "@/modules/diagrams/types";
import { EXTERNAL_ID_SYSTEMS } from "@/modules/patients/constants";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { requirePermission } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import { composeSections, type ChartValue } from "./compose";
import { buildReportDocx } from "./docx";
import { MAX_SECTION_CHARS, reportTemplate, requiredDiagrams, type ReportTemplate } from "./templates";

/**
 * Reports (R5, ADR-034). A report belongs to one visit and one template.
 * Versions are append-only: drafts (no file), then "final" with a .docx, then
 * "amended" versions, each with its own .docx; a finalized version is never
 * replaced. The first draft is composed from the chart; the doctor edits it,
 * previews it, and a doctor (report.finalize) finalizes it.
 */

export class ReportNotFoundError extends Error {
  constructor(id: string) {
    super(`Report not found: ${id}`);
    this.name = "ReportNotFoundError";
  }
}
export class InvalidReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReportError";
  }
}
export class ReportConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super("This report was saved by someone else after you opened it.");
    this.name = "ReportConflictError";
  }
}
export class ReportMutationReuseError extends Error {
  constructor() {
    super("clientMutationId was already used for a different change.");
    this.name = "ReportMutationReuseError";
  }
}

export const reportContentSchema = z
  .object({
    sections: z.record(z.string().regex(/^[a-z_]{1,40}$/), z.string().max(MAX_SECTION_CHARS)),
    diagramFileIds: z.partialRecord(z.enum(["leg", "vein"]), z.string().uuid().nullable()),
  })
  .strict();

export type ReportStatus = "draft" | "final" | "amended";

export interface DiagramChoice {
  fileId: string;
  fileName: string;
}

export interface ReportEditorData {
  template: ReportTemplate;
  exists: boolean;
  version: number;
  status: ReportStatus | null;
  content: ReportContent;
  listStyle: "bullets" | "numbers";
  /** Saved diagram versions of this visit, newest first, per type. */
  diagramChoices: Record<DiagramType, DiagramChoice[]>;
  patientName: string;
  fileNumber: string | null;
  date: string;
}

function formatDmy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function dateIn(timeZone: string, at: Date): string {
  return todayIn(timeZone, at);
}

/** Current value of every clinical field recorded on the visit, as report text. */
async function chartValues(db: Database, visitId: string): Promise<Record<string, ChartValue>> {
  const entries = await db
    .selectDistinctOn([clinicalEntries.fieldDefinitionId], {
      code: clinicalFieldDefinitions.code,
      value: clinicalEntries.value,
    })
    .from(clinicalEntries)
    .innerJoin(clinicalFieldDefinitions, eq(clinicalFieldDefinitions.id, clinicalEntries.fieldDefinitionId))
    .where(eq(clinicalEntries.visitId, visitId))
    .orderBy(clinicalEntries.fieldDefinitionId, desc(clinicalEntries.version));
  const optionIds = [...new Set(entries.flatMap((e) => e.value.optionIds))];
  const labels = new Map(
    (optionIds.length === 0
      ? []
      : await db.select({ id: clinicalOptions.id, label: clinicalOptions.label, sort: clinicalOptions.sortOrder })
          .from(clinicalOptions)
          .where(inArray(clinicalOptions.id, optionIds))
          .orderBy(asc(clinicalOptions.sortOrder))
    ).map((o) => [o.id, o.label]),
  );
  const out: Record<string, ChartValue> = {};
  for (const e of entries) {
    const parts = [...e.value.optionIds.map((id) => labels.get(id) ?? ""), e.value.freeText].filter((p) => p.trim());
    out[e.code] = { text: parts.join(", "), checked: e.value.checked === true };
  }
  return out;
}

/** Treatment Plan procedures whose Completed date is the visit date (ADR-030). */
async function proceduresCompletedOn(db: Database, patientId: string, isoDate: string): Promise<string[]> {
  const cells = await db
    .selectDistinctOn([treatmentPlanEntries.itemId, treatmentPlanEntries.fieldDefinitionId], {
      itemId: treatmentPlanEntries.itemId,
      position: treatmentPlanItems.position,
      code: clinicalFieldDefinitions.code,
      value: treatmentPlanEntries.value,
    })
    .from(treatmentPlanEntries)
    .innerJoin(treatmentPlanItems, eq(treatmentPlanItems.id, treatmentPlanEntries.itemId))
    .innerJoin(clinicalFieldDefinitions, eq(clinicalFieldDefinitions.id, treatmentPlanEntries.fieldDefinitionId))
    .where(eq(treatmentPlanItems.patientId, patientId))
    .orderBy(treatmentPlanEntries.itemId, treatmentPlanEntries.fieldDefinitionId, desc(treatmentPlanEntries.version));
  const byItem = new Map<string, { position: number; cells: Map<string, (typeof cells)[number]["value"]> }>();
  for (const c of cells) {
    const row = byItem.get(c.itemId) ?? { position: c.position, cells: new Map() };
    row.cells.set(c.code, c.value);
    byItem.set(c.itemId, row);
  }
  const optionIds = [...byItem.values()].flatMap((r) => r.cells.get("treatment_procedure")?.optionIds ?? []);
  const labels = new Map(
    (optionIds.length === 0
      ? []
      : await db.select().from(clinicalOptions).where(inArray(clinicalOptions.id, optionIds))
    ).map((o) => [o.id, o.label]),
  );
  return [...byItem.values()]
    .filter((r) => r.cells.get("treatment_completed")?.freeText === isoDate && !r.cells.get("treatment_cancelled")?.checked)
    .sort((a, b) => a.position - b.position)
    .map((r) => {
      const v = r.cells.get("treatment_procedure");
      return [...(v?.optionIds.map((id) => labels.get(id) ?? "") ?? []), v?.freeText ?? ""].filter(Boolean).join(", ");
    })
    .filter(Boolean);
}

async function diagramChoices(db: Database, visitId: string): Promise<Record<DiagramType, DiagramChoice[]>> {
  const rows = await db
    .select({ type: diagrams.diagramType, fileId: patientFiles.id, fileName: patientFiles.fileName, createdAt: diagramVersions.createdAt })
    .from(diagramVersions)
    .innerJoin(diagrams, eq(diagrams.id, diagramVersions.diagramId))
    .innerJoin(patientFiles, eq(patientFiles.id, diagramVersions.pngFileId))
    .where(eq(diagrams.visitId, visitId))
    .orderBy(desc(diagramVersions.createdAt));
  return {
    leg: rows.filter((r) => r.type === "leg").map(({ fileId, fileName }) => ({ fileId, fileName })),
    vein: rows.filter((r) => r.type === "vein").map(({ fileId, fileName }) => ({ fileId, fileName })),
  };
}

async function visitContext(db: Database, visitId: string, timeZone: string) {
  const [row] = await db
    .select({ visit: visits, patient: patients })
    .from(visits)
    .innerJoin(patients, eq(patients.id, visits.patientId))
    .where(eq(visits.id, visitId))
    .limit(1);
  if (!row) throw new VisitNotFoundError(visitId);
  const [fileNo] = await db
    .select({ value: patientExternalIds.value })
    .from(patientExternalIds)
    .where(and(eq(patientExternalIds.patientId, row.patient.id), eq(patientExternalIds.system, EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO)))
    .limit(1);
  const visitIso = dateIn(timeZone, row.visit.visitDate);
  return {
    visit: row.visit,
    patient: row.patient,
    fileNumber: fileNo?.value ?? null,
    visitIso,
    patientName: `${row.patient.firstName} ${row.patient.lastName}`.trim(),
  };
}

/** Everything the report editor needs: the latest saved content, or a first draft composed from the chart. */
export async function getReportEditorData(
  db: Database,
  actor: ActorContext,
  input: { visitId: string; reportId: string; templateCode?: string },
  timeZone: string,
): Promise<ReportEditorData> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_READ, { entityType: "report", entityId: input.reportId, visitId: input.visitId });
  const ctx = await visitContext(db, input.visitId, timeZone);
  const [report] = await db.select().from(reports).where(eq(reports.id, input.reportId)).limit(1);
  if (report && report.visitId !== input.visitId) throw new ReportNotFoundError(input.reportId);
  const template = reportTemplate(report?.templateCode ?? input.templateCode ?? "");
  if (!template) throw new ReportNotFoundError(input.reportId);

  const values = await chartValues(db, input.visitId);
  const choices = await diagramChoices(db, input.visitId);
  const [latest] = report
    ? await db.select().from(reportVersions).where(eq(reportVersions.reportId, report.id)).orderBy(desc(reportVersions.version)).limit(1)
    : [];

  const content: ReportContent = latest?.content ?? {
    sections: composeSections({
      patient: {
        firstName: ctx.patient.firstName,
        lastName: ctx.patient.lastName,
        sex: ctx.patient.sex === "F" || ctx.patient.sex === "M" ? ctx.patient.sex : null,
        age: ageOn(ctx.patient.dateOfBirth, ctx.visitIso),
      },
      values,
      proceduresToday: await proceduresCompletedOn(db, ctx.patient.id, ctx.visitIso),
    }),
    // Default: the latest saved diagram of each type on this visit (FINAL_V1 §9.1).
    diagramFileIds: { leg: choices.leg[0]?.fileId ?? null, vein: choices.vein[0]?.fileId ?? null },
  };

  return {
    template,
    exists: Boolean(report),
    version: latest?.version ?? 0,
    status: (latest?.status as ReportStatus | undefined) ?? null,
    content,
    listStyle: values.impression_list_style?.text === "numbers" ? "numbers" : "bullets",
    diagramChoices: choices,
    patientName: ctx.patientName,
    fileNumber: ctx.fileNumber,
    date: formatDmy(ctx.visitIso),
  };
}

export interface ReportListItem {
  id: string;
  templateName: string;
  versions: { version: number; status: ReportStatus; fileId: string | null; fileName: string | null; createdAt: Date; createdByName: string | null }[];
}

export async function listReportsForVisit(db: Database, actor: ActorContext, visitId: string): Promise<ReportListItem[]> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_READ, { entityType: "report", entityId: visitId, visitId });
  const rows = await db.select().from(reports).where(eq(reports.visitId, visitId)).orderBy(asc(reports.createdAt));
  if (rows.length === 0) return [];
  const versions = await db
    .select({
      reportId: reportVersions.reportId,
      version: reportVersions.version,
      status: reportVersions.status,
      fileId: patientFiles.id,
      fileName: patientFiles.fileName,
      createdAt: reportVersions.createdAt,
      createdByName: users.displayName,
    })
    .from(reportVersions)
    .leftJoin(patientFiles, eq(patientFiles.id, reportVersions.docxFileId))
    .leftJoin(users, eq(users.id, reportVersions.createdBy))
    .where(inArray(reportVersions.reportId, rows.map((r) => r.id)))
    .orderBy(desc(reportVersions.version));
  return rows.map((r) => ({
    id: r.id,
    templateName: reportTemplate(r.templateCode)?.name ?? r.templateCode,
    versions: versions
      .filter((v) => v.reportId === r.id)
      .map((v) => ({
        version: v.version,
        status: v.status as ReportStatus,
        fileId: v.fileId,
        fileName: v.fileName,
        createdAt: v.createdAt,
        createdByName: v.createdByName,
      })),
  }));
}

export interface SaveReportInput {
  visitId: string;
  reportId: string;
  templateCode: string;
  expectedVersion: number;
  clientMutationId: string;
  action: "draft" | "finalize";
  content: ReportContent;
}

export interface SaveReportResult {
  replayed: boolean;
  version: number;
  status: ReportStatus;
  fileId: string | null;
  fileName: string | null;
}

const MUTATION_INDEX = "report_versions_client_mutation_id_idx";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function saveReportVersion(
  db: Database,
  storage: FileStorage,
  actor: ActorContext,
  input: SaveReportInput,
  timeZone: string,
): Promise<SaveReportResult> {
  await requirePermission(
    db,
    actor,
    input.action === "finalize" ? PERMISSIONS.REPORT_FINALIZE : PERMISSIONS.CLINICAL_WRITE,
    { entityType: "report", entityId: input.reportId, visitId: input.visitId },
  );
  const template = reportTemplate(input.templateCode);
  if (!template) throw new InvalidReportError("Unknown report template.");
  const content = reportContentSchema.safeParse(input.content);
  if (!content.success) throw new InvalidReportError(content.error.issues[0]?.message ?? "Invalid report content.");
  const sectionKeys = new Set(template.sections.map((s) => s.key));
  const sections = Object.fromEntries(Object.entries(content.data.sections).filter(([k]) => sectionKeys.has(k)));

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.clientMutationId}, 0))`);
      const [locked] = await tx.select({ id: visits.id }).from(visits).where(eq(visits.id, input.visitId)).limit(1).for("update");
      if (!locked) throw new VisitNotFoundError(input.visitId);
      const ctx = await visitContext(tx, input.visitId, timeZone);

      const [applied] = await tx
        .select()
        .from(reportVersions)
        .where(eq(reportVersions.clientMutationId, input.clientMutationId))
        .limit(1);
      if (applied) {
        if (applied.reportId !== input.reportId || applied.createdBy !== actor.userId || applied.version !== input.expectedVersion + 1) {
          throw new ReportMutationReuseError();
        }
        const [file] = applied.docxFileId
          ? await tx.select().from(patientFiles).where(eq(patientFiles.id, applied.docxFileId)).limit(1)
          : [];
        return { replayed: true, version: applied.version, status: applied.status as ReportStatus, fileId: file?.id ?? null, fileName: file?.fileName ?? null };
      }

      if (ctx.visit.status !== "open") throw new VisitNotOpenError(ctx.visit.id, ctx.visit.status);

      const [report] = await tx.select().from(reports).where(eq(reports.id, input.reportId)).limit(1);
      if (report && (report.visitId !== ctx.visit.id || report.templateCode !== template.code)) {
        throw new ReportNotFoundError(input.reportId);
      }
      const history = report
        ? await tx.select({ version: reportVersions.version, status: reportVersions.status }).from(reportVersions)
            .where(eq(reportVersions.reportId, report.id)).orderBy(desc(reportVersions.version))
        : [];
      const current = history[0]?.version ?? 0;
      if (input.expectedVersion !== current) throw new ReportConflictError(current);
      const finalized = history.some((h) => h.status !== "draft");
      if (input.action === "draft" && finalized) {
        throw new InvalidReportError("This report is finalized. Changes are saved as an amended version.");
      }
      const status: ReportStatus = input.action === "draft" ? "draft" : finalized ? "amended" : "final";

      // Diagrams must be saved diagrams of THIS visit, of the right type.
      const choices = await diagramChoices(tx, ctx.visit.id);
      const diagramBytes: Partial<Record<DiagramType, Uint8Array>> = {};
      for (const type of requiredDiagrams(template)) {
        const fileId = content.data.diagramFileIds[type] ?? null;
        if (fileId && !choices[type].some((c) => c.fileId === fileId)) {
          throw new InvalidReportError(`The chosen ${type} diagram is not a saved diagram of this visit.`);
        }
        if (status !== "draft") {
          if (!fileId) {
            throw new InvalidReportError(
              `This template needs a ${type === "leg" ? "Leg" : "Vein"} Diagram. Create and save one for this visit, then finalize.`,
            );
          }
          const [file] = await tx.select().from(patientFiles).where(eq(patientFiles.id, fileId)).limit(1);
          if (file) diagramBytes[type] = await storage.get(file.storageKey);
        }
      }

      const meta = { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null };
      if (!report) {
        await tx.insert(reports).values({
          id: input.reportId,
          patientId: ctx.patient.id,
          visitId: ctx.visit.id,
          templateCode: template.code,
          createdBy: actor.userId,
        });
        await writeAudit(tx, {
          actorUserId: actor.userId,
          action: "report.create",
          entityType: "report",
          entityId: input.reportId,
          patientId: ctx.patient.id,
          visitId: ctx.visit.id,
          after: { templateCode: template.code },
          metadata: meta,
        });
      }

      const version = current + 1;
      let fileId: string | null = null;
      let fileName: string | null = null;
      const saved: ReportContent = { sections, diagramFileIds: content.data.diagramFileIds };
      if (status !== "draft") {
        const [me] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, actor.userId)).limit(1);
        const values = await chartValues(tx, ctx.visit.id);
        const bytes = await buildReportDocx({
          template,
          sections,
          listStyle: values.impression_list_style?.text === "numbers" ? "numbers" : "bullets",
          patientName: ctx.patientName,
          fileNumber: ctx.fileNumber,
          date: formatDmy(ctx.visitIso),
          doctorName: `Dr. ${me?.name ?? ""}`.trim(),
          diagrams: diagramBytes,
        });
        fileId = randomUUID();
        const label = template.code === "short_procedure" ? "Template1" : "Template2";
        fileName = `${ctx.visitIso}_Report_${label}_v${String(version).padStart(2, "0")}.docx`;
        const storageKey = `patients/${ctx.patient.id}/reports/${fileId}.docx`;
        await storage.put(storageKey, bytes);
        await tx.insert(patientFiles).values({
          id: fileId,
          patientId: ctx.patient.id,
          visitId: ctx.visit.id,
          kind: "report",
          storageKey,
          fileName,
          contentType: DOCX_TYPE,
          byteSize: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          createdBy: actor.userId,
        });
      }
      await tx.insert(reportVersions).values({
        reportId: input.reportId,
        version,
        status,
        content: saved,
        docxFileId: fileId,
        clientMutationId: input.clientMutationId,
        createdBy: actor.userId,
      });
      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: status === "draft" ? "report_version.draft" : status === "final" ? "report_version.finalize" : "report_version.amend",
        entityType: "report",
        entityId: input.reportId,
        patientId: ctx.patient.id,
        visitId: ctx.visit.id,
        after: { version, status, fileId, fileName, content: saved },
        metadata: { ...meta, clientMutationId: input.clientMutationId },
      });
      return { replayed: false, version, status, fileId, fileName };
    });
  } catch (err) {
    if (isUniqueViolation(err) && pgErrorField(err, "constraint") === MUTATION_INDEX) throw new ReportMutationReuseError();
    throw err;
  }
}
