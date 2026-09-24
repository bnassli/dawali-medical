import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { and, asc, eq, sql } from "drizzle-orm";
import { createDb, type Database } from "../src/db/client";
import {
  auditLogs,
  clinicalEntries,
  clinicalFieldDefinitions,
  sessions,
} from "../src/db/schema";
import { loadActorContext } from "../src/modules/auth/service";
import { createPatient } from "../src/modules/patients/service";
import { createVisit } from "../src/modules/visits/service";
import type { E2EUser, E2EUserKey } from "./global-setup";

export function user(key: E2EUserKey): E2EUser {
  const raw = process.env.E2E_USERS;
  if (!raw) throw new Error("E2E_USERS is not set — global setup did not run.");
  const users = JSON.parse(raw) as Record<E2EUserKey, E2EUser>;
  return users[key];
}

export function uniq(): string {
  return randomUUID().slice(0, 8);
}

/** Runs `fn` with a short-lived DB connection (tests only use it for fixtures and assertions). */
export async function withDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL is not set.");
  const { db, pool } = createDb(url);
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}

export async function loginAs(page: Page, key: E2EUserKey): Promise<void> {
  const u = user(key);
  await page.goto("/login");
  await page.getByLabel("Email").fill(u.email);
  await page.getByLabel("Password").fill(u.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/patients");
}

export interface VisitFixture {
  patientId: string;
  visitId: string;
}

/** Creates a patient + open visit through the real services, as the E2E doctor. */
export async function createVisitFixture(
  opts: { patientId?: string; reason?: string } = {},
): Promise<VisitFixture> {
  return withDb(async (db) => {
    const actor = await loadActorContext(db, user("doctor").userId);
    if (!actor) throw new Error("doctor actor not found");
    let patientId = opts.patientId;
    if (!patientId) {
      const s = uniq();
      const patient = await createPatient(db, actor, {
        firstName: `E2E-${s}`,
        lastName: `Patient-${s}`,
        middleName: undefined,
        dateOfBirth: undefined,
        sex: undefined,
        phone: undefined,
        email: undefined,
        icareFileNo: undefined,
      });
      patientId = patient.id;
    }
    const visit = await createVisit(db, actor, { patientId, reason: opts.reason });
    return { patientId, visitId: visit.id };
  });
}

export async function createPatientFixture(): Promise<string> {
  return withDb(async (db) => {
    const actor = await loadActorContext(db, user("doctor").userId);
    if (!actor) throw new Error("doctor actor not found");
    const s = uniq();
    const patient = await createPatient(db, actor, {
      firstName: `E2E-${s}`,
      lastName: `Patient-${s}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    return patient.id;
  });
}

export function visitUrl(f: VisitFixture): string {
  return `/patients/${f.patientId}/visits/${f.visitId}`;
}

export interface EntryRow {
  version: number;
  freeText: string;
  optionIds: string[];
  createdBy: string | null;
}

export async function entryHistory(visitId: string, fieldCode: string): Promise<EntryRow[]> {
  return withDb(async (db) => {
    const rows = await db
      .select({
        version: clinicalEntries.version,
        value: clinicalEntries.value,
        createdBy: clinicalEntries.createdBy,
      })
      .from(clinicalEntries)
      .innerJoin(
        clinicalFieldDefinitions,
        eq(clinicalFieldDefinitions.id, clinicalEntries.fieldDefinitionId),
      )
      .where(and(eq(clinicalEntries.visitId, visitId), eq(clinicalFieldDefinitions.code, fieldCode)))
      .orderBy(asc(clinicalEntries.version));
    return rows.map((r) => ({
      version: r.version,
      freeText: r.value.freeText,
      optionIds: r.value.optionIds,
      createdBy: r.createdBy,
    }));
  });
}

export async function clinicalAuditCount(visitId: string): Promise<number> {
  return withDb(async (db) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(and(eq(auditLogs.visitId, visitId), eq(auditLogs.entityType, "clinical_entry")));
    return row?.n ?? 0;
  });
}

export async function clinicalAudits(visitId: string) {
  return withDb((db) =>
    db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.visitId, visitId), eq(auditLogs.entityType, "clinical_entry")))
      .orderBy(asc(auditLogs.id)),
  );
}

export async function revokeSessions(userId: string): Promise<void> {
  await withDb((db) =>
    db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.userId, userId)),
  );
}

export async function legacyVisitReason(visitId: string): Promise<string | null> {
  return withDb(async (db) => {
    const result = await db.execute<{ reason: string | null }>(
      sql`SELECT reason FROM visits WHERE id = ${visitId}`,
    );
    return result.rows[0]?.reason ?? null;
  });
}

export async function optionLabels(): Promise<string[]> {
  return withDb(async (db) => {
    const result = await db.execute<{ label: string }>(sql`SELECT label FROM clinical_options`);
    return result.rows.map((r) => r.label);
  });
}

/** Container of one clinical field, addressed by its stable field code. */
export function field(page: Page, code: string): Locator {
  return page.locator(`[data-field="${code}"]`);
}

export function statusOf(page: Page, code: string): Locator {
  return field(page, code).getByRole("status");
}

export function unsavedBanner(page: Page): Locator {
  return page.getByTestId("unsaved-banner");
}
