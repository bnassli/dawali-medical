import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs, clinicalEntries, clinicalFieldDefinitions } from "@/db/schema";
import {
  addClinicalOption,
  ClinicalConflictError,
  MutationIdReuseError,
  saveClinicalEntry,
} from "@/modules/clinical/service";
import { createPatient } from "@/modules/patients/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

describe("clinical entries: optimistic concurrency and idempotency", () => {
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

  async function newVisit(actor: ActorContext) {
    const suffix = uniqueSuffix();
    const patient = await createPatient(db, actor, {
      firstName: `Cy-${suffix}`,
      lastName: `Conc-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    const visit = await createVisit(db, actor, { patientId: patient.id, reason: undefined });
    return { patient, visit };
  }

  async function fieldId(code: string): Promise<string> {
    const [row] = await db
      .select({ id: clinicalFieldDefinitions.id })
      .from(clinicalFieldDefinitions)
      .where(eq(clinicalFieldDefinitions.code, code))
      .limit(1);
    if (!row) throw new Error(`field ${code} not seeded`);
    return row.id;
  }

  const save = (
    actor: ActorContext,
    visitId: string,
    fieldId: string,
    freeText: string,
    expectedVersion: number,
    clientMutationId: string = randomUUID(),
    optionIds: string[] = [],
  ) =>
    saveClinicalEntry(db, actor, {
      visitId,
      fieldId,
      optionIds,
      freeText,
      expectedVersion,
      clientMutationId,
    });

  async function counts(visitId: string) {
    const [entries] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(clinicalEntries)
      .where(eq(clinicalEntries.visitId, visitId));
    const [audits] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(and(eq(auditLogs.visitId, visitId), eq(auditLogs.entityType, "clinical_entry")));
    return { entries: entries?.n ?? 0, audits: audits?.n ?? 0 };
  }

  it("rejects a stale save with a conflict, preserves the other user's value and writes no revision or audit row", async () => {
    const { actor: alice } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { actor: bob } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(alice);
    const fid = await fieldId("comments");

    // Both load version 0. Alice saves first.
    await save(alice, visit.id, fid, "alice's text", 0);
    const before = await counts(visit.id);

    // Bob still believes version 0: his save must be refused.
    const attempt = save(bob, visit.id, fid, "bob's text", 0);
    await expect(attempt).rejects.toBeInstanceOf(ClinicalConflictError);
    await attempt.catch((err: unknown) => {
      const conflict = err as ClinicalConflictError;
      expect(conflict.current.version).toBe(1);
      expect(conflict.current.value.freeText).toBe("alice's text");
    });

    expect(await counts(visit.id)).toEqual(before);
    const rows = await db
      .select()
      .from(clinicalEntries)
      .where(eq(clinicalEntries.visitId, visit.id));
    expect(rows.map((r) => r.value.freeText)).toEqual(["alice's text"]);
  });

  it("a conflict on a select field returns the current options so 'Use theirs' can render them", async () => {
    const { actor: alice } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(alice);
    const fid = await fieldId("progression");
    const option = await addClinicalOption(db, alice, {
      fieldId: fid,
      label: `Worsening ${uniqueSuffix()}`,
    });
    await save(alice, visit.id, fid, "", 0, randomUUID(), [option.id]);

    const err = await save(alice, visit.id, fid, "late", 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClinicalConflictError);
    const conflict = err as ClinicalConflictError;
    expect(conflict.current.value.optionIds).toEqual([option.id]);
    expect(conflict.current.options.map((o) => o.id)).toContain(option.id);
  });

  it("treats an expectedVersion ahead of the stored version as a conflict too", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");
    await expect(save(actor, visit.id, fid, "x", 5)).rejects.toBeInstanceOf(ClinicalConflictError);
    expect(await counts(visit.id)).toEqual({ entries: 0, audits: 0 });
  });

  it("of two truly concurrent saves from the same base version exactly one wins", async () => {
    const { actor: alice } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { actor: bob } = await createTestUser(db, { roleCode: "NURSE_ASSISTANT" });
    const { visit } = await newVisit(alice);
    const fid = await fieldId("comments");

    const results = await Promise.allSettled([
      save(alice, visit.id, fid, "from alice", 0),
      save(bob, visit.id, fid, "from bob", 0),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ClinicalConflictError);
    expect(await counts(visit.id)).toEqual({ entries: 1, audits: 1 });
  });

  it("'Keep mine' is an explicit new revision on top of theirs, with theirs kept in history and audit", async () => {
    const { actor: alice } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { actor: bob } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(alice);
    const fid = await fieldId("comments");
    await save(alice, visit.id, fid, "theirs", 0);
    const conflict = await save(bob, visit.id, fid, "mine", 0).catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ClinicalConflictError);

    const kept = await save(bob, visit.id, fid, "mine", (conflict as ClinicalConflictError).current.version);
    expect(kept.version).toBe(2);

    const rows = await db
      .select()
      .from(clinicalEntries)
      .where(eq(clinicalEntries.visitId, visit.id));
    expect(rows.map((r) => r.value.freeText).sort()).toEqual(["mine", "theirs"]);
    const [update] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.visitId, visit.id), eq(auditLogs.action, "clinical_entry.update")));
    expect(update?.before).toMatchObject({ version: 1, value: { freeText: "theirs" } });
    expect(update?.after).toMatchObject({ version: 2, value: { freeText: "mine" } });
  });

  it("replaying a clientMutationId returns the original result and writes nothing", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");
    const mutationId = randomUUID();

    const first = await save(actor, visit.id, fid, "once", 0, mutationId);
    expect(first).toMatchObject({ changed: true, replayed: false, version: 1 });
    const after = await counts(visit.id);

    const replay = await save(actor, visit.id, fid, "once", 0, mutationId);
    expect(replay).toMatchObject({ changed: false, replayed: true, version: 1 });
    expect(replay.value.freeText).toBe("once");
    expect(await counts(visit.id)).toEqual(after);
  });

  it("a replay still succeeds after the field has moved on (no false conflict, no duplicate)", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { actor: other } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");
    const mutationId = randomUUID();
    await save(actor, visit.id, fid, "mine", 0, mutationId);
    await save(other, visit.id, fid, "later by someone else", 1);
    const after = await counts(visit.id);

    const replay = await save(actor, visit.id, fid, "mine", 0, mutationId);
    expect(replay).toMatchObject({ replayed: true, version: 1 });
    expect(replay.value.freeText).toBe("mine");
    expect(await counts(visit.id)).toEqual(after);
  });

  it("concurrent duplicates of one clientMutationId create exactly one revision", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");
    const mutationId = randomUUID();

    const results = await Promise.all([
      save(actor, visit.id, fid, "dup", 0, mutationId),
      save(actor, visit.id, fid, "dup", 0, mutationId),
      save(actor, visit.id, fid, "dup", 0, mutationId),
    ]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(2);
    expect(await counts(visit.id)).toEqual({ entries: 1, audits: 1 });
  });

  it("rejects reuse of a clientMutationId for a different field or by a different user", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { actor: other } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const commentsId = await fieldId("comments");
    const chestId = await fieldId("chest_comments");
    const mutationId = randomUUID();
    await save(actor, visit.id, commentsId, "a", 0, mutationId);
    const after = await counts(visit.id);

    await expect(save(actor, visit.id, chestId, "b", 0, mutationId)).rejects.toBeInstanceOf(
      MutationIdReuseError,
    );
    await expect(save(other, visit.id, commentsId, "c", 1, mutationId)).rejects.toBeInstanceOf(
      MutationIdReuseError,
    );
    expect(await counts(visit.id)).toEqual(after);
  });

  it("a no-op save (same value, new mutation id) writes no revision and no audit row", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");
    await save(actor, visit.id, fid, "same", 0);
    const after = await counts(visit.id);

    const noop = await save(actor, visit.id, fid, "  same  ", 1);
    expect(noop).toMatchObject({ changed: false, replayed: false, version: 1 });
    expect(await counts(visit.id)).toEqual(after);
  });

  it("a no-op save whose expectedVersion is stale is still a conflict, not a silent success", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { actor: other } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");
    await save(actor, visit.id, fid, "v1", 0);
    await save(other, visit.id, fid, "v2", 1);
    await expect(save(actor, visit.id, fid, "v2", 1)).rejects.toBeInstanceOf(ClinicalConflictError);
  });
});
