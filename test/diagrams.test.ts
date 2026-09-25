import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs, visits } from "@/db/schema";
import { LocalFileStorage } from "@/lib/file-storage";
import { VisitNotOpenError } from "@/modules/clinical/service";
import { handleGetFile, handleSaveDiagram } from "@/modules/diagrams/api";
import {
  DiagramConflictError,
  diagramFileName,
  DiagramMutationReuseError,
  DiagramNotFoundError,
  getDiagramForEditing,
  InvalidDiagramError,
  listDiagramsForVisit,
  readPatientFile,
  saveDiagramVersion,
} from "@/modules/diagrams/service";
import { createPatient } from "@/modules/patients/service";
import { ForbiddenError } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

// Smallest valid PNG header + some bytes (content is opaque to the server).
const png = (tag: string) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(tag)]);
const STROKE = [{ color: "#d11a2a", width: 4, erase: false, points: [10, 10, 50, 60] }];
const TZ = "Asia/Riyadh";

describe("Diagrams (R4, ADR-033)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let doctor: ActorContext;
  let dir: string;
  let storage: LocalFileStorage;

  beforeAll(async () => {
    ({ db, close } = openTestDb());
    doctor = (await createTestUser(db, { roleCode: "DOCTOR" })).actor;
    dir = mkdtempSync(path.join(os.tmpdir(), "dawali-files-"));
    storage = new LocalFileStorage(dir);
  });
  afterAll(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function newVisit() {
    const s = uniqueSuffix();
    const p = await createPatient(db, doctor, {
      firstName: `Dg-${s}`,
      lastName: `Diagram-${s}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    return (await createVisit(db, doctor, { patientId: p.id, reason: undefined })).id;
  }
  const input = (visitId: string, diagramId: string, over: Partial<Parameters<typeof saveDiagramVersion>[3]> = {}) => ({
    visitId,
    diagramId,
    diagramType: "leg" as const,
    expectedVersion: 0,
    clientMutationId: randomUUID(),
    strokes: STROKE,
    png: png("v1"),
    ...over,
  });

  it("names files like 2026-09-24_1030_LegDiagram_v01.png in clinic time", () => {
    expect(diagramFileName("leg", 1, new Date("2026-09-24T07:30:00Z"), TZ)).toBe("2026-09-24_1030_LegDiagram_v01.png");
    expect(diagramFileName("vein", 12, new Date("2026-09-24T07:30:00Z"), TZ)).toBe("2026-09-24_1030_VeinDiagram_v12.png");
  });

  it("first save creates the diagram; every save is a new version with its own private file", async () => {
    const visitId = await newVisit();
    const id = randomUUID();
    expect(await listDiagramsForVisit(db, doctor, visitId)).toEqual([]);
    const v1 = await saveDiagramVersion(db, storage, doctor, input(visitId, id), TZ);
    const v2 = await saveDiagramVersion(
      db,
      storage,
      doctor,
      input(visitId, id, { expectedVersion: 1, png: png("v2"), strokes: [...STROKE, { ...STROKE[0]!, erase: true }] }),
      TZ,
    );
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(v1.fileId).not.toBe(v2.fileId);
    const list = await listDiagramsForVisit(db, doctor, visitId);
    expect(list).toHaveLength(1);
    expect(list[0]?.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(Buffer.from((await readPatientFile(db, storage, doctor, v1.fileId)).bytes).toString()).toContain("v1");
    expect(Buffer.from((await readPatientFile(db, storage, doctor, v2.fileId)).bytes).toString()).toContain("v2");
    const editing = await getDiagramForEditing(db, doctor, visitId, id);
    expect(editing).toMatchObject({ diagramType: "leg", version: 2 });
    expect(editing.strokes).toHaveLength(2);
    // Stored outside the database, under the patient's folder.
    expect(readdirSync(dir, { recursive: true }).some((f) => String(f).endsWith(`${v2.fileId}.png`))).toBe(true);
  });

  it("never overwrites: a stale save is a conflict and writes nothing", async () => {
    const visitId = await newVisit();
    const id = randomUUID();
    await saveDiagramVersion(db, storage, doctor, input(visitId, id), TZ);
    await expect(saveDiagramVersion(db, storage, doctor, input(visitId, id), TZ)).rejects.toBeInstanceOf(
      DiagramConflictError,
    );
    expect((await listDiagramsForVisit(db, doctor, visitId))[0]?.versions).toHaveLength(1);
  });

  it("replays a mutation id and refuses its reuse", async () => {
    const visitId = await newVisit();
    const id = randomUUID();
    const first = input(visitId, id);
    const a = await saveDiagramVersion(db, storage, doctor, first, TZ);
    await expect(saveDiagramVersion(db, storage, doctor, first, TZ)).resolves.toMatchObject({ replayed: true, fileId: a.fileId });
    await expect(saveDiagramVersion(db, storage, doctor, { ...first, png: png("other") }, TZ)).rejects.toBeInstanceOf(
      DiagramMutationReuseError,
    );
  });

  it("validates the image and the drawing; an empty drawing is not saved", async () => {
    const visitId = await newVisit();
    for (const bad of [
      { png: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) },
      { strokes: [] },
      { strokes: [{ color: "red", width: 4, erase: false, points: [1, 2] }] },
      { strokes: [{ ...STROKE[0]!, points: [1, 2, 3] }] },
    ]) {
      await expect(saveDiagramVersion(db, storage, doctor, input(visitId, randomUUID(), bad), TZ)).rejects.toBeInstanceOf(
        InvalidDiagramError,
      );
    }
  });

  it("a diagram belongs to its visit and type; other visits cannot write to it", async () => {
    const a = await newVisit();
    const b = await newVisit();
    const id = randomUUID();
    await saveDiagramVersion(db, storage, doctor, input(a, id), TZ);
    await expect(saveDiagramVersion(db, storage, doctor, input(b, id, { expectedVersion: 1 }), TZ)).rejects.toBeInstanceOf(
      DiagramNotFoundError,
    );
    await expect(
      saveDiagramVersion(db, storage, doctor, input(a, id, { expectedVersion: 1, diagramType: "vein" }), TZ),
    ).rejects.toBeInstanceOf(DiagramNotFoundError);
    await expect(getDiagramForEditing(db, doctor, b, id)).rejects.toBeInstanceOf(DiagramNotFoundError);
  });

  it("closed visits, permissions, append-only tables and audit", async () => {
    const visitId = await newVisit();
    const id = randomUUID();
    const nurse = (await createTestUser(db, { roleCode: "NURSE_ASSISTANT" })).actor;
    const admin = (await createTestUser(db, { roleCode: "ADMIN" })).actor;
    const reception = (await createTestUser(db, { roleCode: "RECEPTION" })).actor;
    const saved = await saveDiagramVersion(db, storage, nurse, input(visitId, id), TZ);
    await expect(saveDiagramVersion(db, storage, admin, input(visitId, id, { expectedVersion: 1 }), TZ)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(readPatientFile(db, storage, reception, saved.fileId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(readPatientFile(db, storage, admin, saved.fileId)).resolves.toBeDefined();

    for (const q of [
      sql`UPDATE diagram_versions SET version = 9 WHERE diagram_id = ${id}`,
      sql`DELETE FROM diagrams WHERE id = ${id}`,
      sql`UPDATE patient_files SET file_name = 'x' WHERE id = ${saved.fileId}`,
    ]) {
      const err = await db.execute(q).then(() => null, (e: unknown) => e);
      const cause = err instanceof Error ? (err.cause ?? err) : null;
      expect(cause instanceof Error ? cause.message : "").toMatch(/append-only/);
    }

    const actions = (await db.select().from(auditLogs).where(eq(auditLogs.visitId, visitId))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["diagram.create", "diagram_version.create", "patient_file.read"]));

    await db.update(visits).set({ status: "closed" }).where(eq(visits.id, visitId));
    await expect(saveDiagramVersion(db, storage, doctor, input(visitId, id, { expectedVersion: 1 }), TZ)).rejects.toBeInstanceOf(
      VisitNotOpenError,
    );
  });

  it("Route Handlers: save by JSON, serve the file privately, refuse the unauthenticated", async () => {
    const visitId = await newVisit();
    const id = randomUUID();
    const deps = (actor: ActorContext | null) => ({ db, resolveActor: async () => actor, appOrigin: null, allowRequestOrigin: true });
    const res = await handleSaveDiagram(
      new Request("http://localhost:3000/x", {
        method: "POST",
        headers: { origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({
          expectedUserId: doctor.userId,
          diagramType: "vein",
          expectedVersion: 0,
          clientMutationId: randomUUID(),
          strokes: STROKE,
          pngBase64: Buffer.from(png("api")).toString("base64"),
        }),
      }),
      { visitId, diagramId: id },
      deps(doctor),
      storage,
      TZ,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fileId: string; fileName: string };
    expect(body.fileName).toMatch(/_VeinDiagram_v01\.png$/);

    const file = await handleGetFile({ fileId: body.fileId }, deps(doctor), storage);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("cache-control")).toBe("private, no-store");
    expect((await handleGetFile({ fileId: body.fileId }, deps(null), storage)).status).toBe(401);
    expect((await handleGetFile({ fileId: randomUUID() }, deps(doctor), storage)).status).toBe(404);
  });

  it("storage refuses unsafe keys and never replaces a file", async () => {
    await expect(storage.put("../escape.png", png("x"))).rejects.toThrow(/Unsafe/);
    await storage.put("patients/p/diagrams/once.png", png("a"));
    await expect(storage.put("patients/p/diagrams/once.png", png("b"))).rejects.toThrow();
  });
});
