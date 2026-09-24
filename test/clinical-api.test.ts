import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs, clinicalEntries, clinicalFieldDefinitions, visits } from "@/db/schema";
import {
  handleAddClinicalOption,
  handleSaveClinicalEntry,
  isSameOrigin,
  MAX_SAVE_BODY_BYTES,
  type ApiDeps,
} from "@/modules/clinical/api";
import { createPatient } from "@/modules/patients/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

const ORIGIN = "http://localhost:3000";

interface Json {
  ok: boolean;
  error?: string;
  message?: string;
  changed?: boolean;
  replayed?: boolean;
  version?: number;
  value?: { optionIds: string[]; freeText: string };
  current?: { version: number; value: { freeText: string }; options: unknown[] };
  option?: { id: string; label: string };
}

describe("clinical autosave Route Handler logic", () => {
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

  const depsFor = (actor: ActorContext | null): ApiDeps => ({
    db,
    resolveActor: async () => actor,
  });

  function post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    raw?: string,
  ): Request {
    return new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        ...headers,
      },
      body: raw ?? JSON.stringify(body),
    });
  }

  async function newVisit(actor: ActorContext) {
    const suffix = uniqueSuffix();
    const patient = await createPatient(db, actor, {
      firstName: `Api-${suffix}`,
      lastName: `Route-${suffix}`,
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

  const body = (freeText: string, expectedVersion = 0, id: string = randomUUID()) => ({
    expectedVersion,
    clientMutationId: id,
    optionIds: [],
    freeText,
  });

  async function call(
    actor: ActorContext | null,
    visitId: string,
    fid: string,
    req: Request,
  ): Promise<{ status: number; json: Json }> {
    const res = await handleSaveClinicalEntry(req, { visitId, fieldId: fid }, depsFor(actor));
    return { status: res.status, json: (await res.json()) as Json };
  }

  const path = (visitId: string, fid: string) => `/api/visits/${visitId}/clinical-entries/${fid}`;

  async function entryCount(visitId: string): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(clinicalEntries)
      .where(eq(clinicalEntries.visitId, visitId));
    return row?.n ?? 0;
  }

  it("200: saves, returns the new version, and derives patientId from the visit", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit, patient } = await newVisit(actor);
    const fid = await fieldId("comments");

    const { status, json } = await call(
      actor,
      visit.id,
      fid,
      post(path(visit.id, fid), body("hello")),
    );
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, changed: true, replayed: false, version: 1 });

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.visitId, visit.id), eq(auditLogs.action, "clinical_entry.create")));
    expect(audit?.patientId).toBe(patient.id);
  });

  it("400: a client-supplied patientId (or any unknown key) is rejected, never trusted", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");
    const { status, json } = await call(
      actor,
      visit.id,
      fid,
      post(path(visit.id, fid), { ...body("x"), patientId: randomUUID() }),
    );
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_input");
    expect(await entryCount(visit.id)).toBe(0);
  });

  it("401: no session (body is not even parsed)", async () => {
    const fid = await fieldId("comments");
    const { status, json } = await call(
      null,
      randomUUID(),
      fid,
      post("/x", null, {}, "{not json"),
    );
    expect(status).toBe(401);
    expect(json.error).toBe("unauthenticated");
  });

  it("403: cross-origin requests are refused before authentication", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");
    const evil = await call(
      actor,
      visit.id,
      fid,
      post(path(visit.id, fid), body("x"), { origin: "https://evil.example" }),
    );
    expect(evil.status).toBe(403);
    expect(evil.json.error).toBe("cross_origin");

    const noOrigin = new Request(`${ORIGIN}${path(visit.id, fid)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body("x")),
    });
    expect((await call(actor, visit.id, fid, noOrigin)).status).toBe(403);

    const fetchMeta = new Request(`${ORIGIN}${path(visit.id, fid)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(body("y")),
    });
    expect((await call(actor, visit.id, fid, fetchMeta)).status).toBe(200);
    expect(await entryCount(visit.id)).toBe(1);
  });

  it("isSameOrigin honours X-Forwarded-Host behind a proxy", () => {
    const req = new Request("http://internal:3000/api/x", {
      method: "POST",
      headers: { origin: "https://clinic.example", "x-forwarded-host": "clinic.example" },
    });
    expect(isSameOrigin(req)).toBe(true);
  });

  it("403: missing permission (Reception) and the denial is audited with the visit", async () => {
    const { actor: doctor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { actor: reception } = await createTestUser(db, { roleCode: "RECEPTION" });
    const { visit } = await newVisit(doctor);
    const fid = await fieldId("comments");
    const { status, json } = await call(
      reception,
      visit.id,
      fid,
      post(path(visit.id, fid), body("nope")),
    );
    expect(status).toBe(403);
    expect(json.error).toBe("forbidden");
    const denied = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, "access.denied"), eq(auditLogs.actorUserId, reception.userId)),
      );
    expect(denied.some((d) => d.visitId === visit.id)).toBe(true);
    expect(await entryCount(visit.id)).toBe(0);
  });

  it("400: malformed JSON, invalid body, bad ids", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");

    const badJson = await call(actor, visit.id, fid, post("/x", null, {}, "{oops"));
    expect(badJson.status).toBe(400);
    expect(badJson.json.error).toBe("invalid_json");

    const missing = await call(actor, visit.id, fid, post("/x", { freeText: "x" }));
    expect(missing.status).toBe(400);

    const negative = await call(actor, visit.id, fid, post("/x", { ...body("x"), expectedVersion: -1 }));
    expect(negative.status).toBe(400);

    const badMutationId = await call(
      actor,
      visit.id,
      fid,
      post("/x", { ...body("x"), clientMutationId: "not-a-uuid" }),
    );
    expect(badMutationId.status).toBe(400);

    const badIds = await call(actor, "not-a-uuid", fid, post("/x", body("x")));
    expect(badIds.status).toBe(400);

    // Invalid value for the field type (options on a text field).
    const invalidValue = await call(
      actor,
      visit.id,
      fid,
      post("/x", { ...body("x"), optionIds: [randomUUID()] }),
    );
    expect(invalidValue.status).toBe(400);
    expect(invalidValue.json.error).toBe("invalid_value");
    expect(await entryCount(visit.id)).toBe(0);
  });

  it("415 / 413: wrong content type and oversized bodies are refused (declared and undeclared size)", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");

    const text = await call(
      actor,
      visit.id,
      fid,
      post("/x", null, { "content-type": "text/plain" }, JSON.stringify(body("x"))),
    );
    expect(text.status).toBe(415);

    const declared = await call(
      actor,
      visit.id,
      fid,
      post("/x", body("x"), { "content-length": String(MAX_SAVE_BODY_BYTES + 1) }),
    );
    expect(declared.status).toBe(413);

    // No Content-Length: the byte limit is enforced while reading.
    const huge = JSON.stringify({ ...body("x"), freeText: "a".repeat(MAX_SAVE_BODY_BYTES) });
    const undeclared = await call(actor, visit.id, fid, post("/x", null, {}, huge));
    expect(undeclared.status).toBe(413);
    expect(await entryCount(visit.id)).toBe(0);
  });

  it("404: unknown visit or field", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");
    expect((await call(actor, randomUUID(), fid, post("/x", body("x")))).status).toBe(404);
    expect((await call(actor, visit.id, randomUUID(), post("/x", body("x")))).status).toBe(404);
  });

  it("409: stale expectedVersion returns the other user's current value and writes nothing", async () => {
    const { actor: alice } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { actor: bob } = await createTestUser(db, { roleCode: "NURSE_ASSISTANT" });
    const { visit } = await newVisit(alice);
    const fid = await fieldId("comments");

    expect((await call(alice, visit.id, fid, post("/x", body("alice")))).status).toBe(200);
    const stale = await call(bob, visit.id, fid, post("/x", body("bob", 0)));
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe("conflict");
    expect(stale.json.current?.version).toBe(1);
    expect(stale.json.current?.value.freeText).toBe("alice");
    expect(await entryCount(visit.id)).toBe(1);
  });

  it("200 replayed: the same clientMutationId is idempotent over HTTP", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");
    const id = randomUUID();
    const first = await call(actor, visit.id, fid, post("/x", body("once", 0, id)));
    const again = await call(actor, visit.id, fid, post("/x", body("once", 0, id)));
    expect(first.json).toMatchObject({ changed: true, replayed: false, version: 1 });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ changed: false, replayed: true, version: 1 });
    expect(await entryCount(visit.id)).toBe(1);
  });

  it("423: a visit that is not open is locked", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");
    await db.update(visits).set({ status: "closed" }).where(eq(visits.id, visit.id));
    const { status, json } = await call(actor, visit.id, fid, post("/x", body("late")));
    expect(status).toBe(423);
    expect(json.error).toBe("visit_locked");
    expect(await entryCount(visit.id)).toBe(0);
  });

  it("add-option endpoint: 200, 409 duplicate, 403 for nurse, 401 without session, 400 bad body", async () => {
    const { actor: doctor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { actor: nurse } = await createTestUser(db, { roleCode: "NURSE_ASSISTANT" });
    const fid = await fieldId("tobacco");
    const label = `Cigars ${uniqueSuffix()}`;
    const add = async (actor: ActorContext | null, payload: unknown) => {
      const res = await handleAddClinicalOption(
        post("/x", payload),
        { fieldId: fid },
        depsFor(actor),
      );
      return { status: res.status, json: (await res.json()) as Json };
    };

    const ok = await add(doctor, { label });
    expect(ok.status).toBe(200);
    expect(ok.json.option?.label).toBe(label);
    expect((await add(doctor, { label: label.toLowerCase() })).status).toBe(409);
    expect((await add(nurse, { label: `Nurse ${uniqueSuffix()}` })).status).toBe(403);
    expect((await add(null, { label: "x" })).status).toBe(401);
    expect((await add(doctor, { label: "   " })).status).toBe(400);
    expect((await add(doctor, { label: "x", extra: 1 })).status).toBe(400);
  });
});
