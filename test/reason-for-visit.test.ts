import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs, clinicalEntries, clinicalFieldDefinitions } from "@/db/schema";
import { verifyLegacyReasonBackfill } from "@/db/verify-reason-backfill";
import { getVisitReasons } from "@/modules/clinical/service";
import { createPatient } from "@/modules/patients/service";
import type { ActorContext } from "@/modules/permissions/types";
import { ForbiddenError } from "@/modules/permissions/service";
import { createVisit, getVisitById, listVisitsForPatient } from "@/modules/visits/service";
import { createTestUser, openTestDb, saveCurrent, uniqueSuffix } from "./helpers";

const MIGRATION = path.resolve(
  process.cwd(),
  "drizzle",
  "0005_reason_for_visit_single_source.sql",
);

function migrationStatements(): string[] {
  return readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe("Reason for Visit has exactly one authoritative source (ADR-024)", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(() => {
    const opened = openTestDb();
    db = opened.db;
    close = opened.close;
  });

  afterAll(async () => {
    await close();
  });

  async function newPatient(actor: ActorContext) {
    const suffix = uniqueSuffix();
    return createPatient(db, actor, {
      firstName: `Rea-${suffix}`,
      lastName: `Son-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
  }

  async function reasonFieldId(): Promise<string> {
    const [row] = await db
      .select({ id: clinicalFieldDefinitions.id })
      .from(clinicalFieldDefinitions)
      .where(eq(clinicalFieldDefinitions.code, "reason_for_visit"))
      .limit(1);
    if (!row) throw new Error("reason_for_visit not defined");
    return row.id;
  }

  async function legacyReason(visitId: string): Promise<string | null> {
    const result = await db.execute<{ reason: string | null }>(
      sql`SELECT reason FROM visits WHERE id = ${visitId}`,
    );
    return result.rows[0]?.reason ?? null;
  }

  /** Inserts a visit the way pre-Sprint-2 code did (legacy column only), bypassing the read-only guard. */
  async function insertLegacyVisit(
    patientId: string,
    reason: string | null,
    createdBy: string,
  ): Promise<string> {
    await db.execute(sql`ALTER TABLE visits DISABLE TRIGGER visits_reason_read_only`);
    try {
      const result = await db.execute<{ id: string }>(
        sql`INSERT INTO visits (patient_id, reason, created_by) VALUES (${patientId}, ${reason}, ${createdBy}) RETURNING id`,
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error("legacy visit insert failed");
      return id;
    } finally {
      await db.execute(sql`ALTER TABLE visits ENABLE TRIGGER visits_reason_read_only`);
    }
  }

  async function runBackfill(): Promise<void> {
    for (const statement of migrationStatements()) {
      await db.execute(sql.raw(statement));
    }
  }

  it("createVisit stores the intake reason ONLY in clinical_entries, with an audit row", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const patient = await newPatient(actor);
    const visit = await createVisit(db, actor, { patientId: patient.id, reason: "  Leg pain  " });

    expect(await legacyReason(visit.id)).toBeNull();
    expect("reason" in visit).toBe(false);

    const entries = await db
      .select()
      .from(clinicalEntries)
      .where(
        and(
          eq(clinicalEntries.visitId, visit.id),
          eq(clinicalEntries.fieldDefinitionId, await reasonFieldId()),
        ),
      );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.version).toBe(1);
    expect(entries[0]?.value).toEqual({ optionIds: [], freeText: "Leg pain" });

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.visitId, visit.id), eq(auditLogs.entityType, "clinical_entry")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "clinical_entry.create",
      patientId: patient.id,
      actorUserId: actor.userId,
    });
    expect(audits[0]?.metadata).toMatchObject({ source: "visit.create" });

    const visitAudit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.visitId, visit.id), eq(auditLogs.action, "visit.create")));
    expect(visitAudit[0]?.after).not.toHaveProperty("reason");
  });

  it("createVisit without a reason (or a blank one) creates no clinical entry", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const patient = await newPatient(actor);
    const a = await createVisit(db, actor, { patientId: patient.id, reason: undefined });
    const b = await createVisit(db, actor, { patientId: patient.id, reason: undefined });
    for (const v of [a, b]) {
      const rows = await db.select().from(clinicalEntries).where(eq(clinicalEntries.visitId, v.id));
      expect(rows).toHaveLength(0);
    }
  });

  it("readers get Reason for Visit from clinical_entries: intake text and later edits, latest version wins", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const patient = await newPatient(actor);
    const visit = await createVisit(db, actor, { patientId: patient.id, reason: "Initial" });
    expect((await getVisitReasons(db, actor, [visit.id])).get(visit.id)).toBe("Initial");

    await saveCurrent(db, actor, {
      visitId: visit.id,
      fieldId: await reasonFieldId(),
      optionIds: [],
      freeText: "Updated in the clinical tab",
    });
    expect((await getVisitReasons(db, actor, [visit.id])).get(visit.id)).toBe(
      "Updated in the clinical tab",
    );

    // Visit records no longer expose a reason at all.
    const listed = await listVisitsForPatient(db, actor, patient.id);
    expect(listed.every((v) => !("reason" in v))).toBe(true);
    expect(await getVisitById(db, actor, visit.id)).not.toHaveProperty("reason");
  });

  it("reading Reason for Visit requires clinical.read (Reception cannot)", async () => {
    const { actor: doctor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { actor: reception } = await createTestUser(db, { roleCode: "RECEPTION" });
    const patient = await newPatient(doctor);
    const visit = await createVisit(db, doctor, { patientId: patient.id, reason: "x" });
    await expect(getVisitReasons(db, reception, [visit.id])).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the database refuses writes to the deprecated visits.reason column", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const patient = await newPatient(actor);
    const visit = await createVisit(db, actor, { patientId: patient.id, reason: undefined });

    await expect(
      db.execute(sql`UPDATE visits SET reason = 'sneaky' WHERE id = ${visit.id}`),
    ).rejects.toThrow();
    await expect(
      db.execute(
        sql`INSERT INTO visits (patient_id, reason) VALUES (${patient.id}, 'sneaky insert')`,
      ),
    ).rejects.toThrow();
    // Other columns remain updatable, and rewriting the same value is allowed.
    await db.execute(sql`UPDATE visits SET status = 'open', reason = reason WHERE id = ${visit.id}`);
  });

  it("backfills every non-empty legacy reason with an audit row, skips blanks, keeps the raw value, and is idempotent", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const patient = await newPatient(actor);
    const long = `Långt ✓ ${"x".repeat(3000)}`;
    const padded = await insertLegacyVisit(patient.id, "  Varicose veins  ", actor.userId);
    const unicode = await insertLegacyVisit(patient.id, long, actor.userId);
    const blank = await insertLegacyVisit(patient.id, "   ", actor.userId);
    const nullReason = await insertLegacyVisit(patient.id, null, actor.userId);

    const before = await verifyLegacyReasonBackfill(db);
    expect(before.missing).toBeGreaterThanOrEqual(2);

    await runBackfill();

    const fid = await reasonFieldId();
    const entryFor = async (visitId: string) =>
      db
        .select()
        .from(clinicalEntries)
        .where(and(eq(clinicalEntries.visitId, visitId), eq(clinicalEntries.fieldDefinitionId, fid)));

    const [paddedEntry] = await entryFor(padded);
    expect(paddedEntry).toMatchObject({ version: 1, createdBy: actor.userId });
    expect(paddedEntry?.value).toEqual({ optionIds: [], freeText: "Varicose veins" });
    const [unicodeEntry] = await entryFor(unicode);
    expect(unicodeEntry?.value.freeText).toBe(long);
    expect(await entryFor(blank)).toHaveLength(0);
    expect(await entryFor(nullReason)).toHaveLength(0);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.visitId, padded), eq(auditLogs.action, "clinical_entry.backfill")));
    expect(audit).toMatchObject({ patientId: patient.id, entityId: paddedEntry?.id });
    expect(audit?.metadata).toMatchObject({
      source: "visits.reason",
      legacyValue: "  Varicose veins  ",
    });

    // The legacy column itself is untouched (rollback safety).
    expect(await legacyReason(padded)).toBe("  Varicose veins  ");

    const report = await verifyLegacyReasonBackfill(db);
    expect(report.missing).toBe(0);

    // Re-running changes nothing.
    const [entriesBefore] = await db.select({ n: sql<number>`count(*)::int` }).from(clinicalEntries);
    const [auditsBefore] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs);
    await runBackfill();
    const [entriesAfter] = await db.select({ n: sql<number>`count(*)::int` }).from(clinicalEntries);
    const [auditsAfter] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs);
    expect(entriesAfter?.n).toBe(entriesBefore?.n);
    expect(auditsAfter?.n).toBe(auditsBefore?.n);
  });

  it("never discards a legacy value when the visit already has a different entry: it is preserved in the audit log", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const patient = await newPatient(actor);
    const visitId = await insertLegacyVisit(patient.id, "Legacy text", actor.userId);
    await saveCurrent(db, actor, {
      visitId,
      fieldId: await reasonFieldId(),
      optionIds: [],
      freeText: "Already typed in the clinical tab",
    });

    await runBackfill();

    const entries = await db
      .select()
      .from(clinicalEntries)
      .where(eq(clinicalEntries.visitId, visitId));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value.freeText).toBe("Already typed in the clinical tab");
    const skipped = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.visitId, visitId), eq(auditLogs.action, "clinical_entry.backfill_skipped")));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.metadata).toMatchObject({ legacyValue: "Legacy text" });

    // Re-run does not duplicate the skipped-audit row.
    await runBackfill();
    const again = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.visitId, visitId), eq(auditLogs.action, "clinical_entry.backfill_skipped")));
    expect(again).toHaveLength(1);
    const report = await verifyLegacyReasonBackfill(db);
    expect(report.missing).toBe(0);
    expect(report.divergent).toBeGreaterThanOrEqual(1);
  });

  it("the migration's verification step aborts if a legacy reason has no clinical entry", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const patient = await newPatient(actor);
    await insertLegacyVisit(patient.id, "Would be lost", actor.userId);

    const verify = migrationStatements().find((s) => s.startsWith("DO $$"));
    expect(verify).toBeDefined();
    await expect(db.execute(sql.raw(verify ?? ""))).rejects.toThrow(/verification failed/);
    expect((await verifyLegacyReasonBackfill(db)).missing).toBeGreaterThanOrEqual(1);

    await runBackfill();
    expect((await verifyLegacyReasonBackfill(db)).missing).toBe(0);
  });

  it("no application code reads or writes visits.reason", () => {
    const srcRoot = path.resolve(process.cwd(), "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    walk(srcRoot);

    const allowed = new Set([path.join(srcRoot, "db", "schema", "visits.ts")]);
    const offenders: string[] = [];
    for (const file of files) {
      if (allowed.has(file)) continue;
      // sql text in the verifier/CLI legitimately reads the legacy column.
      if (file.includes("verify-reason-backfill")) continue;
      // Inspect code only: drop comments and string literals.
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
      if (/visits\.reason\b/.test(text)) offenders.push(`${file}: references visits.reason`);
      if (/\.select\(\)\s*\.from\(visits\)/.test(text)) {
        offenders.push(`${file}: select() of visits without an explicit column list`);
      }
      if (/insert\(visits\)[\s\S]{0,300}?\.returning\(\)/.test(text)) {
        offenders.push(`${file}: insert into visits with returning() of all columns`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
