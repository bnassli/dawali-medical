import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/client";
import { diagrams, diagramVersions, patientFiles, users, visits, type DiagramStroke } from "@/db/schema";
import type { FileStorage } from "@/lib/file-storage";
import { writeAudit } from "@/modules/audit/service";
import { isUniqueViolation, pgErrorField, VisitNotFoundError, VisitNotOpenError } from "@/modules/clinical/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { requirePermission } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import {
  DIAGRAM_TYPES,
  MAX_DIAGRAM_PNG_BYTES,
  MAX_DIAGRAM_POINTS,
  MAX_DIAGRAM_STROKES,
  type DiagramType,
} from "./types";

/**
 * Diagrams (R4, ADR-033): a Leg or Vein diagram belongs to one visit. Every
 * save is a NEW version (v1, v2, ...) holding the editable strokes and a
 * rendered PNG stored as a private patient file; nothing is ever overwritten.
 * Same concurrency/idempotency/audit rules as clinical entries.
 */

export class DiagramNotFoundError extends Error {
  constructor(id: string) {
    super(`Diagram not found: ${id}`);
    this.name = "DiagramNotFoundError";
  }
}
export class PatientFileNotFoundError extends Error {
  constructor(id: string) {
    super(`File not found: ${id}`);
    this.name = "PatientFileNotFoundError";
  }
}
export class InvalidDiagramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDiagramError";
  }
}
export class DiagramConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super("This diagram was saved by someone else after you opened it.");
    this.name = "DiagramConflictError";
  }
}
export class DiagramMutationReuseError extends Error {
  constructor() {
    super("clientMutationId was already used for a different change.");
    this.name = "DiagramMutationReuseError";
  }
}

export const strokeSchema = z
  .object({
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    width: z.number().min(0.5).max(60),
    erase: z.boolean(),
    points: z.array(z.number().finite().min(-10).max(5000)).min(2).max(MAX_DIAGRAM_POINTS),
  })
  .strict();

export const strokesSchema = z
  .array(strokeSchema)
  .max(MAX_DIAGRAM_STROKES)
  .refine((s) => s.reduce((n, x) => n + x.points.length, 0) <= MAX_DIAGRAM_POINTS, "Drawing is too large.")
  .refine((s) => s.every((x) => x.points.length % 2 === 0), "Points must be x,y pairs.");

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > PNG_MAGIC.length && PNG_MAGIC.every((b, i) => bytes[i] === b);
}

/** "2026-09-24_1030_LegDiagram_v01.png" in the clinic's time zone (FINAL_V1 §8.3). */
export function diagramFileName(type: DiagramType, version: number, at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const v = String(version).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}_${DIAGRAM_TYPES[type].fileLabel}_v${v}.png`;
}

export interface DiagramVersionView {
  version: number;
  fileId: string;
  fileName: string;
  createdAt: Date;
  createdByName: string | null;
}

export interface DiagramView {
  id: string;
  diagramType: DiagramType;
  createdAt: Date;
  /** Newest first. */
  versions: DiagramVersionView[];
}

async function loadVisit(db: Database, visitId: string) {
  const [visit] = await db
    .select({ id: visits.id, patientId: visits.patientId, status: visits.status })
    .from(visits)
    .where(eq(visits.id, visitId))
    .limit(1);
  if (!visit) throw new VisitNotFoundError(visitId);
  return visit;
}

/** The visit's diagrams with every saved version (newest first). Requires clinical.read. */
export async function listDiagramsForVisit(db: Database, actor: ActorContext, visitId: string): Promise<DiagramView[]> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_READ, { entityType: "diagram", entityId: visitId, visitId });
  await loadVisit(db, visitId);
  const rows = await db
    .select()
    .from(diagrams)
    .where(eq(diagrams.visitId, visitId))
    .orderBy(asc(diagrams.createdAt));
  if (rows.length === 0) return [];
  const versions = await db
    .select({
      diagramId: diagramVersions.diagramId,
      version: diagramVersions.version,
      fileId: patientFiles.id,
      fileName: patientFiles.fileName,
      createdAt: diagramVersions.createdAt,
      createdByName: users.displayName,
    })
    .from(diagramVersions)
    .innerJoin(patientFiles, eq(patientFiles.id, diagramVersions.pngFileId))
    .leftJoin(users, eq(users.id, diagramVersions.createdBy))
    .where(inArray(diagramVersions.diagramId, rows.map((r) => r.id)))
    .orderBy(desc(diagramVersions.version));
  return rows.map((d) => ({
    id: d.id,
    diagramType: d.diagramType as DiagramType,
    createdAt: d.createdAt,
    versions: versions
      .filter((v) => v.diagramId === d.id)
      .map(({ diagramId: _d, ...v }) => {
        void _d;
        return v;
      }),
  }));
}

export interface DiagramForEditing {
  diagramType: DiagramType;
  version: number;
  strokes: DiagramStroke[];
}

/** The latest version of a diagram of this visit, to continue drawing on it. */
export async function getDiagramForEditing(
  db: Database,
  actor: ActorContext,
  visitId: string,
  diagramId: string,
): Promise<DiagramForEditing> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_READ, { entityType: "diagram", entityId: diagramId, visitId });
  const [diagram] = await db
    .select()
    .from(diagrams)
    .where(and(eq(diagrams.id, diagramId), eq(diagrams.visitId, visitId)))
    .limit(1);
  if (!diagram) throw new DiagramNotFoundError(diagramId);
  const [latest] = await db
    .select()
    .from(diagramVersions)
    .where(eq(diagramVersions.diagramId, diagramId))
    .orderBy(desc(diagramVersions.version))
    .limit(1);
  return {
    diagramType: diagram.diagramType as DiagramType,
    version: latest?.version ?? 0,
    strokes: latest?.strokes ?? [],
  };
}

export interface SaveDiagramInput {
  visitId: string;
  diagramId: string;
  diagramType: DiagramType;
  expectedVersion: number;
  clientMutationId: string;
  strokes: DiagramStroke[];
  png: Uint8Array;
}

export interface SaveDiagramResult {
  replayed: boolean;
  version: number;
  fileId: string;
  fileName: string;
}

const MUTATION_INDEX = "diagram_versions_client_mutation_id_idx";

/**
 * Saves a new version. The first save of an unknown diagram id creates the
 * diagram for this visit (the client names it when "Create ... Diagram" is
 * pressed, so an untouched template is never stored). Never overwrites.
 */
export async function saveDiagramVersion(
  db: Database,
  storage: FileStorage,
  actor: ActorContext,
  input: SaveDiagramInput,
  timeZone: string,
): Promise<SaveDiagramResult> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_WRITE, {
    entityType: "diagram",
    entityId: input.diagramId,
    visitId: input.visitId,
  });
  if (!isPng(input.png)) throw new InvalidDiagramError("The drawing must be a PNG image.");
  if (input.png.length > MAX_DIAGRAM_PNG_BYTES) throw new InvalidDiagramError("The drawing image is too large.");
  const strokes = strokesSchema.safeParse(input.strokes);
  if (!strokes.success) throw new InvalidDiagramError(strokes.error.issues[0]?.message ?? "Invalid drawing.");
  if (strokes.data.length === 0) throw new InvalidDiagramError("Draw on the diagram before saving it.");

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.clientMutationId}, 0))`);
      const [visit] = await tx
        .select({ id: visits.id, patientId: visits.patientId, status: visits.status })
        .from(visits)
        .where(eq(visits.id, input.visitId))
        .limit(1)
        .for("update");
      if (!visit) throw new VisitNotFoundError(input.visitId);

      const [applied] = await tx
        .select({ v: diagramVersions, file: patientFiles })
        .from(diagramVersions)
        .innerJoin(patientFiles, eq(patientFiles.id, diagramVersions.pngFileId))
        .where(eq(diagramVersions.clientMutationId, input.clientMutationId))
        .limit(1);
      if (applied) {
        const sha = createHash("sha256").update(input.png).digest("hex");
        if (
          applied.v.diagramId !== input.diagramId ||
          applied.v.createdBy !== actor.userId ||
          applied.v.version !== input.expectedVersion + 1 ||
          applied.file.sha256 !== sha
        ) {
          throw new DiagramMutationReuseError();
        }
        return { replayed: true, version: applied.v.version, fileId: applied.file.id, fileName: applied.file.fileName };
      }

      if (visit.status !== "open") throw new VisitNotOpenError(visit.id, visit.status);

      const [diagram] = await tx.select().from(diagrams).where(eq(diagrams.id, input.diagramId)).limit(1);
      // A diagram of another visit (or patient) is indistinguishable from a missing one.
      if (diagram && (diagram.visitId !== visit.id || diagram.diagramType !== input.diagramType)) {
        throw new DiagramNotFoundError(input.diagramId);
      }
      const [latest] = diagram
        ? await tx
            .select({ version: diagramVersions.version })
            .from(diagramVersions)
            .where(eq(diagramVersions.diagramId, diagram.id))
            .orderBy(desc(diagramVersions.version))
            .limit(1)
        : [];
      const current = latest?.version ?? 0;
      if (input.expectedVersion !== current) throw new DiagramConflictError(current);

      const meta = { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null };
      if (!diagram) {
        const [created] = await tx
          .insert(diagrams)
          .values({
            id: input.diagramId,
            patientId: visit.patientId,
            visitId: visit.id,
            diagramType: input.diagramType,
            createdBy: actor.userId,
          })
          .returning();
        await writeAudit(tx, {
          actorUserId: actor.userId,
          action: "diagram.create",
          entityType: "diagram",
          entityId: input.diagramId,
          patientId: visit.patientId,
          visitId: visit.id,
          after: created,
          metadata: meta,
        });
      }

      const version = current + 1;
      const fileId = randomUUID();
      const fileName = diagramFileName(input.diagramType, version, new Date(), timeZone);
      const storageKey = `patients/${visit.patientId}/diagrams/${fileId}.png`;
      const sha256 = createHash("sha256").update(input.png).digest("hex");
      // Written before the rows: if the transaction then fails, an unreferenced
      // file may remain (harmless, unreachable); a row never points at nothing.
      await storage.put(storageKey, input.png);
      await tx.insert(patientFiles).values({
        id: fileId,
        patientId: visit.patientId,
        visitId: visit.id,
        kind: "diagram",
        storageKey,
        fileName,
        contentType: "image/png",
        byteSize: input.png.length,
        sha256,
        createdBy: actor.userId,
      });
      const [saved] = await tx
        .insert(diagramVersions)
        .values({
          diagramId: input.diagramId,
          version,
          strokes: strokes.data,
          pngFileId: fileId,
          clientMutationId: input.clientMutationId,
          createdBy: actor.userId,
        })
        .returning({ id: diagramVersions.id });
      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: "diagram_version.create",
        entityType: "diagram_version",
        entityId: saved?.id ?? input.diagramId,
        patientId: visit.patientId,
        visitId: visit.id,
        after: { diagramId: input.diagramId, version, fileId, fileName, sha256, strokes: strokes.data.length },
        metadata: { ...meta, clientMutationId: input.clientMutationId },
      });
      return { replayed: false, version, fileId, fileName };
    });
  } catch (err) {
    if (isUniqueViolation(err) && pgErrorField(err, "constraint") === MUTATION_INDEX) {
      throw new DiagramMutationReuseError();
    }
    throw err;
  }
}

/** A stored patient file, for the authenticated file route. Requires clinical.read; audited. */
export async function readPatientFile(
  db: Database,
  storage: FileStorage,
  actor: ActorContext,
  fileId: string,
): Promise<{ bytes: Uint8Array; contentType: string; fileName: string }> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_READ, { entityType: "patient_file", entityId: fileId });
  const [file] = await db.select().from(patientFiles).where(eq(patientFiles.id, fileId)).limit(1);
  if (!file) throw new PatientFileNotFoundError(fileId);
  const bytes = await storage.get(file.storageKey);
  await writeAudit(db, {
    actorUserId: actor.userId,
    action: "patient_file.read",
    entityType: "patient_file",
    entityId: file.id,
    patientId: file.patientId,
    visitId: file.visitId,
    metadata: { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null, fileName: file.fileName },
  });
  return { bytes, contentType: file.contentType, fileName: file.fileName };
}
