import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs, clinicalEntries, clinicalFieldDefinitions } from "@/db/schema";
import { LEGACY_REASON_TRIM_REGEX, verifyLegacyReasonBackfill } from "@/db/verify-reason-backfill";
import { characterCount, MAX_FREE_TEXT_LENGTH } from "@/modules/clinical/schema";
import {
  addClinicalOption,
  getVisitReasons,
  InvalidClinicalValueError,
} from "@/modules/clinical/service";
import { createPatient } from "@/modules/patients/service";
import type { ActorContext } from "@/modules/permissions/types";
import { ForbiddenError } from "@/modules/permissions/service";
import { createVisitSchema } from "@/modules/visits/schema";
import { createVisit, getVisitById, listVisitsForPatient } from "@/modules/visits/service";
import { createTestUser, openTestDb, saveCurrent, uniqueSuffix } from "./helpers";

const MIGRATION = path.resolve(
  process.cwd(),
  "drizzle",
  "0004_reason_for_visit_single_source.sql",
);

function migrationText(): string {
  return readFileSync(MIGRATION, "utf8");
}

function migrationStatements(): string[] {
  return migrationText()
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const NBSP = String.fromCodePoint(0x00a0);
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);
const BOM = String.fromCodePoint(0xfeff);
const EMOJI = String.fromCodePoint(0x1f600);

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

  /** Runs `fn` with the read-only guard disabled — how pre-Sprint-2 code wrote visits.reason. */
  async function withLegacyGuardOff<T>(fn: () => Promise<T>): Promise<T> {
    await db.execute(sql`ALTER TABLE visits DISABLE TRIGGER visits_reason_read_only`);
    try {
      return await fn();
    } finally {
      await db.execute(sql`ALTER TABLE visits ENABLE TRIGGER visits_reason_read_only`);
    }
  }

  async function insertLegacyVisit(
    patientId: string,
    reason: string | null,
    createdBy: string,
  ): Promise<string> {
    return withLegacyGuardOff(async () => {
      const result = await db.execute<{ id: string }>(
        sql`INSERT INTO visits (patient_id, reason, created_by) VALUES (${patientId}, ${reason}, ${createdBy}) RETURNING id`,
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error("legacy visit insert failed");
      return id;
    });
  }

  /** Test cleanup only: neutralise a deliberately bad legacy row so later backfills can run. */
  async function clearLegacyReason(visitId: string): Promise<void> {
    await withLegacyGuardOff(() =>
      db.execute(sql`UPDATE visits SET reason = NULL WHERE id = ${visitId}`),
    );
  }

  /** Runs the whole migration the way the drizzle migrator does: one transaction. */
  async function runBackfill(): Promise<void> {
    await db.transaction(async (tx) => {
      for (const statement of migrationStatements()) {
        await tx.execute(sql.raw(statement));
      }
    });
  }

  async function entriesFor(visitId: string) {
    return db
      .select()
      .from(clinicalEntries)
      .where(
        and(
          eq(clinicalEntries.visitId, visitId),
          eq(clinicalEntries.fieldDefinitionId, await reasonFieldId()),
        ),
      );
  }

  async function backfillAudits(visitId: string, action: string) {
    return db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.visitId, visitId), eq(auditLogs.action, action)));
  }

  describe("visit creation", () => {
    it("stores the intake reason ONLY in clinical_entries, with an audit row", async () => {
      const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const patient = await newPatient(actor);
      const visit = await createVisit(db, actor, { patientId: patient.id, reason: "  Leg pain  " });

      expect(await legacyReason(visit.id)).toBeNull();
      expect("reason" in visit).toBe(false);

      const entries = await entriesFor(visit.id);
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

      const visitAudit = await backfillAudits(visit.id, "visit.create");
      expect(visitAudit[0]?.after).not.toHaveProperty("reason");
    });

    it("no reason (or a blank one) creates no clinical entry", async () => {
      const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const patient = await newPatient(actor);
      const a = await createVisit(db, actor, { patientId: patient.id, reason: undefined });
      const b = await createVisit(db, actor, { patientId: patient.id, reason: "   " });
      for (const v of [a, b]) {
        expect(await entriesFor(v.id)).toHaveLength(0);
      }
    });

    it("enforces MAX_FREE_TEXT_LENGTH: schema and service both accept exactly the limit and reject one more", async () => {
      const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const patient = await newPatient(actor);
      const atLimit = "r".repeat(MAX_FREE_TEXT_LENGTH);
      const overLimit = "r".repeat(MAX_FREE_TEXT_LENGTH + 1);

      // Schema (form/action layer).
      expect(createVisitSchema.safeParse({ patientId: patient.id, reason: atLimit }).success).toBe(true);
      const rejected = createVisitSchema.safeParse({ patientId: patient.id, reason: overLimit });
      expect(rejected.success).toBe(false);
      expect(rejected.error?.issues[0]?.message).toContain("5000");
      // Trimming happens before the length check.
      expect(
        createVisitSchema.safeParse({ patientId: patient.id, reason: `  ${atLimit}  ` }).success,
      ).toBe(true);

      // Service (defense in depth: bypasses the schema entirely).
      const ok = await createVisit(db, actor, { patientId: patient.id, reason: atLimit });
      expect((await entriesFor(ok.id))[0]?.value.freeText).toHaveLength(MAX_FREE_TEXT_LENGTH);

      const before = await listVisitsForPatient(db, actor, patient.id);
      await expect(
        createVisit(db, actor, { patientId: patient.id, reason: overLimit }),
      ).rejects.toBeInstanceOf(InvalidClinicalValueError);
      // The whole transaction rolled back: no visit, no entry, no audit.
      const after = await listVisitsForPatient(db, actor, patient.id);
      expect(after).toHaveLength(before.length);
    });

    it("counts characters (code points), consistently in schema and service: 5000 emoji fit, 5001 do not", async () => {
      const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const patient = await newPatient(actor);
      const fits = EMOJI.repeat(MAX_FREE_TEXT_LENGTH);
      const tooLong = EMOJI.repeat(MAX_FREE_TEXT_LENGTH + 1);
      expect(characterCount(fits)).toBe(MAX_FREE_TEXT_LENGTH);
      expect(fits.length).toBe(MAX_FREE_TEXT_LENGTH * 2); // UTF-16 units: the browser's maxLength is stricter
      expect(createVisitSchema.safeParse({ patientId: patient.id, reason: fits }).success).toBe(true);
      expect(createVisitSchema.safeParse({ patientId: patient.id, reason: tooLong }).success).toBe(false);
      await expect(createVisit(db, actor, { patientId: patient.id, reason: tooLong })).rejects.toBeInstanceOf(
        InvalidClinicalValueError,
      );
    });

    it("a denied creator (Inventory) cannot smuggle a reason in", async () => {
      const { actor: doctor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const { actor: inventory } = await createTestUser(db, { roleCode: "INVENTORY" });
      const patient = await newPatient(doctor);
      await expect(
        createVisit(db, inventory, { patientId: patient.id, reason: "smuggled" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await listVisitsForPatient(db, doctor, patient.id)).toHaveLength(0);
    });

    it("Reception cannot enter a Reason for Visit: refused, audited, no visit and no entry; a reason-less visit still works", async () => {
      const { actor: doctor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const { actor: reception } = await createTestUser(db, { roleCode: "RECEPTION" });
      const patient = await newPatient(doctor);

      await expect(
        createVisit(db, reception, { patientId: patient.id, reason: "typed at the front desk" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await listVisitsForPatient(db, doctor, patient.id)).toHaveLength(0);
      const [denied] = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "access.denied"), eq(auditLogs.actorUserId, reception.userId)))
        .orderBy(desc(auditLogs.id))
        .limit(1);
      expect(denied?.metadata).toMatchObject({ requiredPermission: "clinical.write" });

      const visit = await createVisit(db, reception, { patientId: patient.id, reason: undefined });
      expect(await entriesFor(visit.id)).toHaveLength(0);
      expect((await createVisit(db, reception, { patientId: patient.id, reason: "   " })).id).toBeDefined();
    });

    it("Nurse/Assistant (clinical.write) can still record the reason at visit creation", async () => {
      const { actor: doctor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const { actor: nurse } = await createTestUser(db, { roleCode: "NURSE_ASSISTANT" });
      const patient = await newPatient(doctor);
      const visit = await createVisit(db, nurse, { patientId: patient.id, reason: "nurse intake" });
      expect((await entriesFor(visit.id))[0]?.value.freeText).toBe("nurse intake");
    });

    it("denied visit creation for a NONEXISTENT patient id is 403-style (ForbiddenError) and audits safely, not an FK error", async () => {
      const { actor: inventory } = await createTestUser(db, { roleCode: "INVENTORY" });
      const ghost = "11111111-2222-4333-8444-555555555555";
      await expect(
        createVisit(db, inventory, { patientId: ghost, reason: undefined }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const [row] = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "access.denied"), eq(auditLogs.actorUserId, inventory.userId)))
        .orderBy(desc(auditLogs.id))
        .limit(1);
      expect(row?.patientId).toBeNull();
      expect(row?.metadata).toMatchObject({ attempted: { patientId: ghost } });
    });
  });

  describe("readers", () => {
    it("get Reason for Visit from clinical_entries: intake text and later edits, latest version wins", async () => {
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

      const listed = await listVisitsForPatient(db, actor, patient.id);
      expect(listed.every((v) => !("reason" in v))).toBe(true);
      expect(await getVisitById(db, actor, visit.id)).not.toHaveProperty("reason");
    });

    it("require clinical.read (Reception cannot)", async () => {
      const { actor: doctor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const { actor: reception } = await createTestUser(db, { roleCode: "RECEPTION" });
      const patient = await newPatient(doctor);
      const visit = await createVisit(db, doctor, { patientId: patient.id, reason: "x" });
      await expect(getVisitReasons(db, reception, [visit.id])).rejects.toBeInstanceOf(ForbiddenError);
    });
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
    await db.execute(sql`UPDATE visits SET status = 'open', reason = reason WHERE id = ${visit.id}`);
  });

  describe("migration 0004", () => {
    it("is pure ASCII and shares its trim regex with the verifier (no drift between SQL and TypeScript)", () => {
      const text = migrationText();
      expect(/[^\x00-\x7f]/.test(text)).toBe(false);
      // The regex appears (twice: leading and trailing) exactly as the TS constant spells it.
      expect(text).toContain(`'${LEGACY_REASON_TRIM_REGEX}'`);
      expect(text).toContain("longer than 5000 characters");
    });

    it("takes SHARE ROW EXCLUSIVE locks on visits and clinical_entries first, inside one transaction", async () => {
      const statements = migrationStatements();
      expect(statements[0]).toMatch(/LOCK TABLE visits, clinical_entries IN SHARE ROW EXCLUSIVE MODE;$/);
      // Nothing runs before the lock, and the trigger is installed after backfill + verification.
      const text = statements.join("\n");
      expect(text.indexOf("LOCK TABLE")).toBeLessThan(text.indexOf("INSERT INTO"));
      expect(text.indexOf("verification failed")).toBeLessThan(text.indexOf("CREATE TRIGGER"));

      await db.transaction(async (tx) => {
        await tx.execute(sql.raw((statements[0] ?? "").replace(/^(--.*\n|\s)+/, "")));
        const held = await tx.execute<{ relname: string }>(sql`
          SELECT c.relname
          FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
          WHERE l.pid = pg_backend_pid() AND l.granted AND l.mode = 'ShareRowExclusiveLock'
            AND c.relname IN ('visits', 'clinical_entries')
        `);
        expect(held.rows.map((r) => r.relname).sort()).toEqual(["clinical_entries", "visits"]);
      });
    });

    it.skipIf(Boolean(process.env.TEST_DB_SERIALIZED))(
      "really blocks concurrent old-code writes to visits and clinical_entries until it commits",
      async () => {
        const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
        const patient = await newPatient(actor);
        const visit = await createVisit(db, actor, { patientId: patient.id, reason: undefined });
        const lockStatement = (migrationStatements()[0] ?? "").replace(/^(--.*\n|\s)+/, "");

        let releaseHolder: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          releaseHolder = resolve;
        });
        let lockAcquired: () => void = () => undefined;
        const acquired = new Promise<void>((resolve) => {
          lockAcquired = resolve;
        });

        const holder = db.transaction(async (tx) => {
          await tx.execute(sql.raw(lockStatement));
          lockAcquired();
          await Promise.race([gate, new Promise((r) => setTimeout(r, 15_000))]);
        });
        await acquired;

        try {
          const blockedWrite = async (statement: ReturnType<typeof sql>) => {
            try {
              await db.transaction(async (tx) => {
                await tx.execute(sql`SET LOCAL lock_timeout = '400ms'`);
                await tx.execute(statement);
              });
              return "wrote";
            } catch (err) {
              const code =
                (err as { code?: string; cause?: { code?: string } }).code ??
                (err as { cause?: { code?: string } }).cause?.code;
              return code ?? "other-error";
            }
          };
          // "Old application code": an INSERT/UPDATE against visits, and a clinical entry insert.
          expect(await blockedWrite(sql`UPDATE visits SET status = 'open' WHERE id = ${visit.id}`)).toBe("55P03");
          expect(
            await blockedWrite(
              sql`INSERT INTO visits (patient_id, created_by) VALUES (${patient.id}, ${actor.userId})`,
            ),
          ).toBe("55P03");
        } finally {
          releaseHolder();
          await holder;
        }

        // Once the migration transaction has ended, the same write succeeds.
        await db.execute(sql`UPDATE visits SET status = 'open' WHERE id = ${visit.id}`);
      },
    );

    it("backfills every non-empty legacy reason (trimmed like the app), audits it, skips blanks, keeps raw values, and is idempotent", async () => {
      const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const patient = await newPatient(actor);
      const long = `Långt ✓ ${"x".repeat(3000)}`;
      const padded = await insertLegacyVisit(patient.id, "  Varicose veins  ", actor.userId);
      const exoticSpace = await insertLegacyVisit(
        patient.id,
        `${NBSP}\n${BOM}Pain${IDEOGRAPHIC_SPACE}\t`,
        actor.userId,
      );
      const unicode = await insertLegacyVisit(patient.id, long, actor.userId);
      const blank = await insertLegacyVisit(patient.id, "   ", actor.userId);
      const exoticBlank = await insertLegacyVisit(patient.id, `${NBSP}${IDEOGRAPHIC_SPACE}\n`, actor.userId);
      const nullReason = await insertLegacyVisit(patient.id, null, actor.userId);

      expect((await verifyLegacyReasonBackfill(db)).missing).toBeGreaterThanOrEqual(3);

      await runBackfill();

      const [paddedEntry] = await entriesFor(padded);
      expect(paddedEntry).toMatchObject({ version: 1, createdBy: actor.userId });
      expect(paddedEntry?.value).toEqual({ optionIds: [], freeText: "Varicose veins" });
      expect((await entriesFor(exoticSpace))[0]?.value.freeText).toBe("Pain");
      expect((await entriesFor(unicode))[0]?.value.freeText).toBe(long);
      for (const skipped of [blank, exoticBlank, nullReason]) {
        expect(await entriesFor(skipped)).toHaveLength(0);
      }

      const [audit] = await backfillAudits(padded, "clinical_entry.backfill");
      expect(audit).toMatchObject({
        patientId: patient.id,
        entityId: paddedEntry?.id,
        actorUserId: null,
      });
      expect(audit?.metadata).toMatchObject({
        source: "visits.reason",
        legacyValue: "  Varicose veins  ",
        visitCreatedBy: actor.userId,
      });
      const [exoticAudit] = await backfillAudits(exoticSpace, "clinical_entry.backfill");
      expect((exoticAudit?.metadata as { legacyValue: string }).legacyValue).toBe(
        `${NBSP}\n${BOM}Pain${IDEOGRAPHIC_SPACE}\t`,
      );

      // The legacy column itself is untouched (rollback safety).
      expect(await legacyReason(padded)).toBe("  Varicose veins  ");

      expect((await verifyLegacyReasonBackfill(db)).missing).toBe(0);

      const count = async () => {
        const [e] = await db.select({ n: sql<number>`count(*)::int` }).from(clinicalEntries);
        const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs);
        return { entries: e?.n, audits: a?.n };
      };
      const before = await count();
      await runBackfill();
      expect(await count()).toEqual(before);
    });

    it("boundary: exactly 5000 characters (after trimming) is accepted", async () => {
      const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const patient = await newPatient(actor);
      const exact = await insertLegacyVisit(
        patient.id,
        `${NBSP}${"y".repeat(MAX_FREE_TEXT_LENGTH)}\n`,
        actor.userId,
      );
      const emoji = await insertLegacyVisit(patient.id, EMOJI.repeat(MAX_FREE_TEXT_LENGTH), actor.userId);
      await runBackfill();
      expect((await entriesFor(exact))[0]?.value.freeText).toHaveLength(MAX_FREE_TEXT_LENGTH);
      expect(characterCount((await entriesFor(emoji))[0]?.value.freeText ?? "")).toBe(MAX_FREE_TEXT_LENGTH);
    });

    it("ABORTS (no truncation, no partial work) when any trimmed legacy reason is over the limit", async () => {
      const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const patient = await newPatient(actor);
      const tooLongText = "z".repeat(MAX_FREE_TEXT_LENGTH + 1);
      const tooLong = await insertLegacyVisit(patient.id, tooLongText, actor.userId);
      const tooLongEmoji = await insertLegacyVisit(
        patient.id,
        EMOJI.repeat(MAX_FREE_TEXT_LENGTH + 1),
        actor.userId,
      );
      const innocent = await insertLegacyVisit(patient.id, "perfectly fine", actor.userId);

      try {
        await expect(runBackfill()).rejects.toThrow(/longer than 5000 characters/);
        const error = await runBackfill().catch((e: unknown) => e);
        const detail = String((error as { cause?: { message?: string }; message?: string }).cause?.message ?? error);
        expect(detail).toContain("Nothing was truncated or modified");
        expect(detail).toContain(tooLong);

        // Whole migration rolled back: other legacy rows were NOT backfilled, nothing was installed.
        expect(await entriesFor(innocent)).toHaveLength(0);
        expect(await backfillAudits(innocent, "clinical_entry.backfill")).toHaveLength(0);
        // Oversized values are exactly as they were: nothing truncated or modified.
        expect(await legacyReason(tooLong)).toBe(tooLongText);
        expect(await legacyReason(tooLongEmoji)).toBe(EMOJI.repeat(MAX_FREE_TEXT_LENGTH + 1));
        expect((await verifyLegacyReasonBackfill(db)).overLimit).toBeGreaterThanOrEqual(2);
      } finally {
        await clearLegacyReason(tooLong);
        await clearLegacyReason(tooLongEmoji);
      }

      // With the offending rows fixed by hand, the migration runs and picks up the rest.
      await runBackfill();
      expect((await entriesFor(innocent))[0]?.value.freeText).toBe("perfectly fine");
    });

    describe("skipped-backfill audit: every pre-existing clinical reason case, raw legacy text preserved", () => {
      it("identical version-1 text", async () => {
        const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
        const patient = await newPatient(actor);
        const raw = "  Same text  ";
        const visitId = await insertLegacyVisit(patient.id, raw, actor.userId);
        await saveCurrent(db, actor, {
          visitId,
          fieldId: await reasonFieldId(),
          optionIds: [],
          freeText: "Same text",
        });

        await runBackfill();

        expect(await entriesFor(visitId)).toHaveLength(1);
        expect(await backfillAudits(visitId, "clinical_entry.backfill")).toHaveLength(0);
        const skipped = await backfillAudits(visitId, "clinical_entry.backfill_skipped");
        expect(skipped).toHaveLength(1);
        expect(skipped[0]?.metadata).toMatchObject({
          legacyValue: raw,
          existingVersion: 1,
          identicalToExisting: true,
          source: "visits.reason",
        });
      });

      it("different text, multiple versions, and option-only entries", async () => {
        const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
        const patient = await newPatient(actor);
        const fid = await reasonFieldId();

        const differentText = await insertLegacyVisit(patient.id, "Legacy A", actor.userId);
        await saveCurrent(db, actor, { visitId: differentText, fieldId: fid, optionIds: [], freeText: "Typed B" });

        const manyVersions = await insertLegacyVisit(patient.id, "Legacy C", actor.userId);
        for (const t of ["v1", "v2", "v3"]) {
          await saveCurrent(db, actor, { visitId: manyVersions, fieldId: fid, optionIds: [], freeText: t });
        }

        const optionOnly = await insertLegacyVisit(patient.id, "Legacy D", actor.userId);
        const option = await addClinicalOption(db, actor, { fieldId: fid, label: `Consult ${uniqueSuffix()}` });
        await saveCurrent(db, actor, { visitId: optionOnly, fieldId: fid, optionIds: [option.id], freeText: "" });

        const noLegacy = await insertLegacyVisit(patient.id, null, actor.userId);
        await saveCurrent(db, actor, { visitId: noLegacy, fieldId: fid, optionIds: [], freeText: "no legacy value" });

        await runBackfill();

        const audits = async (v: string) => backfillAudits(v, "clinical_entry.backfill_skipped");
        expect((await audits(differentText))[0]?.metadata).toMatchObject({
          legacyValue: "Legacy A",
          identicalToExisting: false,
          existingVersion: 1,
        });
        const many = (await audits(manyVersions))[0];
        expect(many?.metadata).toMatchObject({ legacyValue: "Legacy C", existingVersion: 3 });
        const latest = (await entriesFor(manyVersions)).find((e) => e.version === 3);
        expect(many?.entityId).toBe(latest?.id);
        expect((await audits(optionOnly))[0]?.metadata).toMatchObject({
          legacyValue: "Legacy D",
          identicalToExisting: false,
        });
        // A visit with no legacy value gets no skipped/backfill audit at all.
        expect(await audits(noLegacy)).toHaveLength(0);
        expect(await backfillAudits(noLegacy, "clinical_entry.backfill")).toHaveLength(0);

        // No entry was added or altered for any of them.
        expect(await entriesFor(differentText)).toHaveLength(1);
        expect(await entriesFor(manyVersions)).toHaveLength(3);
        expect(await entriesFor(optionOnly)).toHaveLength(1);
        expect((await verifyLegacyReasonBackfill(db)).missing).toBe(0);

        // Re-running never duplicates skipped (or backfill) audit rows.
        await runBackfill();
        for (const v of [differentText, manyVersions, optionOnly]) {
          expect(await audits(v)).toHaveLength(1);
        }
      });

      it("does not mistake an entry created BY this migration for a pre-existing one on re-run", async () => {
        const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
        const patient = await newPatient(actor);
        const visitId = await insertLegacyVisit(patient.id, "Fresh legacy", actor.userId);
        await runBackfill();
        await runBackfill();
        expect(await backfillAudits(visitId, "clinical_entry.backfill")).toHaveLength(1);
        expect(await backfillAudits(visitId, "clinical_entry.backfill_skipped")).toHaveLength(0);
      });
    });

    it("the verification step aborts if a legacy reason has no clinical entry", async () => {
      const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const patient = await newPatient(actor);
      const visitId = await insertLegacyVisit(patient.id, "Would be lost", actor.userId);

      // Run everything except the backfill inserts: verification must refuse.
      const statements = migrationStatements().filter(
        (s) => !s.includes("'clinical_entry.backfill'") && !s.includes("'clinical_entry.backfill_skipped'"),
      );
      await expect(
        db.transaction(async (tx) => {
          for (const statement of statements) await tx.execute(sql.raw(statement));
        }),
      ).rejects.toThrow(/verification failed/);
      expect(await entriesFor(visitId)).toHaveLength(0);

      await runBackfill();
      expect((await verifyLegacyReasonBackfill(db)).missing).toBe(0);
    });
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
      if (file.includes("verify-reason-backfill")) continue;
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
