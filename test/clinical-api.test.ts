import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs, clinicalEntries, clinicalFieldDefinitions, visits } from "@/db/schema";
import {
  expectedOriginFor,
  handleAddClinicalOption,
  handleGetClinicalSection,
  handleSaveClinicalEntry,
  isSameOrigin,
  MAX_SAVE_BODY_BYTES,
  normalizeOrigin,
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

  const depsFor = (
    actor: ActorContext | null,
    overrides: Partial<Pick<ApiDeps, "appOrigin" | "allowRequestOrigin">> = {},
  ): ApiDeps => ({
    db,
    resolveActor: async () => actor,
    appOrigin: null,
    allowRequestOrigin: true,
    ...overrides,
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

  /** A well-formed save body for `actor` (the user the page was rendered for). */
  const body = (
    actor: ActorContext,
    freeText: string,
    expectedVersion = 0,
    id: string = randomUUID(),
  ) => ({
    expectedUserId: actor.userId,
    expectedVersion,
    clientMutationId: id,
    optionIds: [] as string[],
    freeText,
  });

  async function call(
    actor: ActorContext | null,
    visitId: string,
    fid: string,
    req: Request,
    deps: ApiDeps = depsFor(actor),
  ): Promise<{ status: number; json: Json }> {
    const res = await handleSaveClinicalEntry(req, { visitId, fieldId: fid }, deps);
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
      post(path(visit.id, fid), body(actor, "hello")),
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
      post(path(visit.id, fid), { ...body(actor, "x"), patientId: randomUUID() }),
    );
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_input");
    expect(await entryCount(visit.id)).toBe(0);
  });

  it("401: no session (body is not even parsed)", async () => {
    const fid = await fieldId("comments");
    const { status, json } = await call(null, randomUUID(), fid, post("/x", null, {}, "{not json"));
    expect(status).toBe(401);
    expect(json.error).toBe("unauthenticated");
  });

  describe("canonical APP_ORIGIN (scheme + host + port)", () => {
    it("normalizeOrigin canonicalises case, default ports and trailing slashes; rejects non-http(s)", () => {
      expect(normalizeOrigin("HTTPS://Clinic.Example:443/")).toBe("https://clinic.example");
      expect(normalizeOrigin("http://clinic.example:80")).toBe("http://clinic.example");
      expect(normalizeOrigin("http://clinic.example:8080/some/path?x=1")).toBe("http://clinic.example:8080");
      expect(normalizeOrigin("null")).toBeNull();
      expect(normalizeOrigin("ftp://clinic.example")).toBeNull();
      expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
    });

    const APP = "https://clinic.example";
    const withOrigin = (origin: string | null, extra: Record<string, string> = {}) => {
      const headers: Record<string, string> = { "content-type": "application/json", ...extra };
      if (origin !== null) headers.origin = origin;
      return new Request("http://internal-host:3000/api/x", { method: "POST", headers, body: "{}" });
    };
    const deps = (appOrigin: string | null, allowRequestOrigin = false) =>
      depsFor(null, { appOrigin, allowRequestOrigin });

    it("accepts exactly the configured origin, however it is spelled", () => {
      const expected = expectedOriginFor(withOrigin(APP), deps(APP));
      expect(expected).toBe(APP);
      expect(isSameOrigin(withOrigin(APP), expected)).toBe(true);
      expect(isSameOrigin(withOrigin("HTTPS://CLINIC.EXAMPLE:443"), expected)).toBe(true);
      expect(expectedOriginFor(withOrigin(APP), deps("https://Clinic.Example/"))).toBe(APP);
    });

    it("rejects a scheme mismatch (http vs https), even with the same host", () => {
      const expected = expectedOriginFor(withOrigin(null), deps(APP));
      expect(isSameOrigin(withOrigin("http://clinic.example"), expected)).toBe(false);
    });

    it("rejects a port mismatch and a host mismatch", () => {
      const expected = expectedOriginFor(withOrigin(null), deps(APP));
      expect(isSameOrigin(withOrigin("https://clinic.example:8443"), expected)).toBe(false);
      expect(isSameOrigin(withOrigin("https://clinic.example.evil.test"), expected)).toBe(false);
      expect(isSameOrigin(withOrigin("https://evil.test"), expected)).toBe(false);
      const local = expectedOriginFor(withOrigin(null), deps("http://localhost:3000"));
      expect(isSameOrigin(withOrigin("http://localhost:3001"), local)).toBe(false);
      expect(isSameOrigin(withOrigin("http://localhost"), local)).toBe(false);
    });

    it("never trusts forwarded headers or Host: only APP_ORIGIN decides", () => {
      const expected = expectedOriginFor(withOrigin(null), deps(APP));
      // Attacker origin whose host is also supplied via X-Forwarded-Host / Host.
      const spoof = withOrigin("https://evil.test", {
        "x-forwarded-host": "evil.test",
        "x-forwarded-proto": "https",
        host: "evil.test",
      });
      expect(isSameOrigin(spoof, expected)).toBe(false);
      // The real origin is not rejected because a proxy rewrote the forwarded headers.
      const proxied = withOrigin(APP, { "x-forwarded-host": "internal-host:3000", "x-forwarded-proto": "http" });
      expect(isSameOrigin(proxied, expected)).toBe(true);
    });

    it("rejects the opaque 'null' origin and requests without Origin unless Sec-Fetch-Site says same-origin", () => {
      const expected = expectedOriginFor(withOrigin(null), deps(APP));
      expect(isSameOrigin(withOrigin("null"), expected)).toBe(false);
      expect(isSameOrigin(withOrigin(null), expected)).toBe(false);
      expect(isSameOrigin(withOrigin(null, { "sec-fetch-site": "cross-site" }), expected)).toBe(false);
      expect(isSameOrigin(withOrigin(null, { "sec-fetch-site": "same-site" }), expected)).toBe(false);
      expect(isSameOrigin(withOrigin(null, { "sec-fetch-site": "same-origin" }), expected)).toBe(true);
    });

    it("fails closed without APP_ORIGIN in production; dev/test may use the request's own origin", () => {
      const req = withOrigin("http://internal-host:3000");
      expect(expectedOriginFor(req, deps(null, false))).toBeNull();
      expect(isSameOrigin(req, expectedOriginFor(req, deps(null, false)))).toBe(false);
      expect(expectedOriginFor(req, deps(null, true))).toBe("http://internal-host:3000");
    });

    it("handler: scheme mismatch is 403 cross_origin and nothing is written; production without APP_ORIGIN is 403", async () => {
      const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const { visit } = await newVisit(actor);
      const fid = await fieldId("comments");
      const strict = depsFor(actor, { appOrigin: "https://clinic.example", allowRequestOrigin: false });

      const scheme = await call(
        actor,
        visit.id,
        fid,
        post(path(visit.id, fid), body(actor, "x"), { origin: "http://clinic.example" }),
        strict,
      );
      expect(scheme.status).toBe(403);
      expect(scheme.json.error).toBe("cross_origin");

      const good = await call(
        actor,
        visit.id,
        fid,
        post(path(visit.id, fid), body(actor, "y"), { origin: "https://clinic.example" }),
        strict,
      );
      expect(good.status).toBe(200);

      const unconfigured = await call(
        actor,
        visit.id,
        fid,
        post(path(visit.id, fid), body(actor, "z", 1), { origin: "https://clinic.example" }),
        depsFor(actor, { appOrigin: null, allowRequestOrigin: false }),
      );
      expect(unconfigured.status).toBe(403);
      expect(unconfigured.json.error).toBe("origin_not_configured");
      expect(await entryCount(visit.id)).toBe(1);
    });
  });

  it("403: cross-origin requests are refused before authentication; Sec-Fetch-Site is accepted when Origin is absent", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");
    const evil = await call(
      actor,
      visit.id,
      fid,
      post(path(visit.id, fid), body(actor, "x"), { origin: "https://evil.example" }),
    );
    expect(evil.status).toBe(403);
    expect(evil.json.error).toBe("cross_origin");

    const noOrigin = new Request(`${ORIGIN}${path(visit.id, fid)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body(actor, "x")),
    });
    expect((await call(actor, visit.id, fid, noOrigin)).status).toBe(403);

    const fetchMeta = new Request(`${ORIGIN}${path(visit.id, fid)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(body(actor, "y")),
    });
    expect((await call(actor, visit.id, fid, fetchMeta)).status).toBe(200);
    expect(await entryCount(visit.id)).toBe(1);
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
      post(path(visit.id, fid), body(reception, "nope")),
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

  it("403 (not 500): a denied user probing a NONEXISTENT visit id gets 403 and the attempt is still audited safely", async () => {
    const { actor: reception } = await createTestUser(db, { roleCode: "RECEPTION" });
    const fid = await fieldId("comments");
    const ghostVisit = randomUUID();

    const { status, json } = await call(
      reception,
      ghostVisit,
      fid,
      post(path(ghostVisit, fid), body(reception, "probe")),
    );
    expect(status).toBe(403);
    expect(json.error).toBe("forbidden");

    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "access.denied"), eq(auditLogs.actorUserId, reception.userId)))
      .orderBy(desc(auditLogs.id))
      .limit(1);
    const row = rows[0];
    expect(row).toBeDefined();
    // No FK column was populated with the nonexistent id; the attempt is in metadata.
    expect(row?.visitId).toBeNull();
    expect(row?.patientId).toBeNull();
    expect(row?.metadata).toMatchObject({
      requiredPermission: "clinical.write",
      attempted: { visitId: ghostVisit, entityId: fid },
    });
  });

  it("a permitted user probing a nonexistent visit id gets a clean 404, not a 500", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const fid = await fieldId("comments");
    const ghost = randomUUID();
    const res = await call(actor, ghost, fid, post(path(ghost, fid), body(actor, "x")));
    expect(res.status).toBe(404);
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

    const noActor = await call(
      actor,
      visit.id,
      fid,
      post("/x", { expectedVersion: 0, clientMutationId: randomUUID(), optionIds: [], freeText: "x" }),
    );
    expect(noActor.status).toBe(400);

    const negative = await call(actor, visit.id, fid, post("/x", { ...body(actor, "x"), expectedVersion: -1 }));
    expect(negative.status).toBe(400);

    const badMutationId = await call(
      actor,
      visit.id,
      fid,
      post("/x", { ...body(actor, "x"), clientMutationId: "not-a-uuid" }),
    );
    expect(badMutationId.status).toBe(400);

    const badIds = await call(actor, "not-a-uuid", fid, post("/x", body(actor, "x")));
    expect(badIds.status).toBe(400);

    // Invalid value for the field type (options on a text field).
    const invalidValue = await call(
      actor,
      visit.id,
      fid,
      post("/x", { ...body(actor, "x"), optionIds: [randomUUID()] }),
    );
    expect(invalidValue.status).toBe(400);
    expect(invalidValue.json.error).toBe("invalid_value");
    expect(await entryCount(visit.id)).toBe(0);
  });

  it("415 / 413: wrong content type and oversized bodies are refused (declared and undeclared size)", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");

    const wrongType = await call(
      actor,
      visit.id,
      fid,
      post("/x", null, { "content-type": "text/plain" }, JSON.stringify(body(actor, "x"))),
    );
    expect(wrongType.status).toBe(415);

    const declared = await call(
      actor,
      visit.id,
      fid,
      post("/x", body(actor, "x"), { "content-length": String(MAX_SAVE_BODY_BYTES + 1) }),
    );
    expect(declared.status).toBe(413);

    // No Content-Length: the byte limit is enforced while reading.
    const huge = JSON.stringify({ ...body(actor, "x"), freeText: "a".repeat(MAX_SAVE_BODY_BYTES) });
    const undeclared = await call(actor, visit.id, fid, post("/x", null, {}, huge));
    expect(undeclared.status).toBe(413);
    expect(await entryCount(visit.id)).toBe(0);
  });

  it("404: unknown visit or field", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");
    expect((await call(actor, randomUUID(), fid, post("/x", body(actor, "x")))).status).toBe(404);
    expect((await call(actor, visit.id, randomUUID(), post("/x", body(actor, "x")))).status).toBe(404);
  });

  it("409: stale expectedVersion returns the other user's current value and writes nothing", async () => {
    const { actor: alice } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { actor: bob } = await createTestUser(db, { roleCode: "NURSE_ASSISTANT" });
    const { visit } = await newVisit(alice);
    const fid = await fieldId("comments");

    expect((await call(alice, visit.id, fid, post("/x", body(alice, "alice")))).status).toBe(200);
    const stale = await call(bob, visit.id, fid, post("/x", body(bob, "bob", 0)));
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
    const first = await call(actor, visit.id, fid, post("/x", body(actor, "once", 0, id)));
    const again = await call(actor, visit.id, fid, post("/x", body(actor, "once", 0, id)));
    expect(first.json).toMatchObject({ changed: true, replayed: false, version: 1 });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ changed: false, replayed: true, version: 1 });
    expect(await entryCount(visit.id)).toBe(1);
  });

  it("400: replaying a clientMutationId with a DIFFERENT value is rejected as reuse and changes nothing", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");
    const id = randomUUID();
    await call(actor, visit.id, fid, post("/x", body(actor, "original", 0, id)));

    const different = await call(actor, visit.id, fid, post("/x", body(actor, "tampered", 0, id)));
    expect(different.status).toBe(400);
    expect(different.json.error).toBe("invalid_value");
    const wrongBase = await call(actor, visit.id, fid, post("/x", body(actor, "original", 1, id)));
    expect(wrongBase.status).toBe(400);
    expect(await entryCount(visit.id)).toBe(1);
  });

  it("400 (never 500): one clientMutationId used CONCURRENTLY on different visits by different users", async () => {
    const { actor: alice } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { actor: bob } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit: visitA } = await newVisit(alice);
    const { visit: visitB } = await newVisit(bob);
    const fid = await fieldId("comments");

    for (let round = 0; round < 5; round += 1) {
      const id = randomUUID();
      const [a, b] = await Promise.all([
        call(alice, visitA.id, fid, post("/x", body(alice, `a${round}`, round, id))),
        call(bob, visitB.id, fid, post("/x", body(bob, `b${round}`, round, id))),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses, `round ${round}`).toEqual([200, 400]);
      // Whichever lost changed nothing; whichever won is the only row for that id.
      const rows = await db
        .select()
        .from(clinicalEntries)
        .where(eq(clinicalEntries.clientMutationId, id));
      expect(rows).toHaveLength(1);
      // Advance the losing side's base version bookkeeping: re-align both visits for the next round.
      const loserVisit = a.status === 400 ? visitA : visitB;
      const loserActor = a.status === 400 ? alice : bob;
      const winnerVisit = a.status === 400 ? visitB : visitA;
      void winnerVisit;
      await call(loserActor, loserVisit.id, fid, post("/x", body(loserActor, `fill${round}`, round)));
    }
  });

  it("423: a visit that is not open is locked", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const fid = await fieldId("comments");
    await db.update(visits).set({ status: "closed" }).where(eq(visits.id, visit.id));
    const { status, json } = await call(actor, visit.id, fid, post("/x", body(actor, "late")));
    expect(status).toBe(423);
    expect(json.error).toBe("visit_locked");
    expect(await entryCount(visit.id)).toBe(0);
  });

  describe("session user changed after the page was rendered (actor binding)", () => {
    it("403 actor_mismatch: text typed as user A is never saved as user B; nothing written, denial audited", async () => {
      const { actor: userA } = await createTestUser(db, { roleCode: "DOCTOR" });
      const { actor: userB } = await createTestUser(db, { roleCode: "DOCTOR" });
      const { visit } = await newVisit(userA);
      const fid = await fieldId("comments");

      // The request was built by a page rendered for A, but the cookie now belongs to B.
      const res = await call(userB, visit.id, fid, post("/x", body(userA, "written as A")));
      expect(res.status).toBe(403);
      expect(res.json.error).toBe("actor_mismatch");
      expect(await entryCount(visit.id)).toBe(0);

      const [denied] = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.actorUserId, userB.userId), eq(auditLogs.action, "access.denied")))
        .orderBy(desc(auditLogs.id))
        .limit(1);
      expect(denied?.visitId).toBe(visit.id);
      expect(denied?.metadata).toMatchObject({ reason: "actor_mismatch", expectedUserId: userA.userId });
      const created = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.visitId, visit.id), eq(auditLogs.action, "clinical_entry.create")));
      expect(created).toHaveLength(0);
    });

    it("the same request goes through once the session belongs to the original user again", async () => {
      const { actor: userA } = await createTestUser(db, { roleCode: "DOCTOR" });
      const { actor: userB } = await createTestUser(db, { roleCode: "DOCTOR" });
      const { visit } = await newVisit(userA);
      const fid = await fieldId("comments");
      const id = randomUUID();
      const payload = body(userA, "retry me", 0, id);

      expect((await call(userB, visit.id, fid, post("/x", payload))).status).toBe(403);
      const retried = await call(userA, visit.id, fid, post("/x", payload));
      expect(retried.status).toBe(200);
      const [row] = await db.select().from(clinicalEntries).where(eq(clinicalEntries.visitId, visit.id));
      expect(row?.createdBy).toBe(userA.userId);
    });

    it("also binds '+ Add New': an option is never created under a different user", async () => {
      const { actor: userA } = await createTestUser(db, { roleCode: "DOCTOR" });
      const { actor: userB } = await createTestUser(db, { roleCode: "DOCTOR" });
      const fid = await fieldId("tobacco");
      const label = `Pipe ${uniqueSuffix()}`;
      const res = await handleAddClinicalOption(
        post("/x", { expectedUserId: userA.userId, label }),
        { fieldId: fid },
        depsFor(userB),
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as Json).error).toBe("actor_mismatch");
      const created = await db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM clinical_options WHERE label = ${label}`,
      );
      expect(created.rows[0]?.n).toBe("0");
    });
  });

  it("add-option endpoint: 200, 409 duplicate, 403 for nurse, 401 without session, 400 bad body", async () => {
    const { actor: doctor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { actor: nurse } = await createTestUser(db, { roleCode: "NURSE_ASSISTANT" });
    const fid = await fieldId("tobacco");
    const label = `Cigars ${uniqueSuffix()}`;
    const add = async (actor: ActorContext | null, payload: unknown) => {
      const res = await handleAddClinicalOption(post("/x", payload), { fieldId: fid }, depsFor(actor));
      return { status: res.status, json: (await res.json()) as Json };
    };

    const ok = await add(doctor, { expectedUserId: doctor.userId, label });
    expect(ok.status).toBe(200);
    expect(ok.json.option?.label).toBe(label);
    expect((await add(doctor, { expectedUserId: doctor.userId, label: label.toLowerCase() })).status).toBe(409);
    expect((await add(nurse, { expectedUserId: nurse.userId, label: `Nurse ${uniqueSuffix()}` })).status).toBe(403);
    expect((await add(null, { expectedUserId: doctor.userId, label: "x" })).status).toBe(401);
    expect((await add(doctor, { expectedUserId: doctor.userId, label: "   " })).status).toBe(400);
    expect((await add(doctor, { expectedUserId: doctor.userId, label: "x", extra: 1 })).status).toBe(400);
    expect((await add(doctor, { label: "x" })).status).toBe(400);
  });

  describe("GET current section state (fresh data after a stale back/forward render)", () => {
    interface SectionJson extends Json {
      visitId?: string;
      fields?: Array<{ id: string; version: number; value: { freeText: string }; isActive: boolean }>;
    }
    const getSection = async (actor: ActorContext | null, visitId: string, sectionCode: string) => {
      const res = await handleGetClinicalSection(
        new Request(`${ORIGIN}/api/visits/${visitId}/clinical-sections/${sectionCode}`),
        { visitId, sectionCode },
        depsFor(actor),
      );
      return { status: res.status, cache: res.headers.get("cache-control"), json: (await res.json()) as SectionJson };
    };

    it("200: returns every field with its CURRENT version and value, never cached", async () => {
      const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const { visit } = await newVisit(actor);
      const fid = await fieldId("comments");
      await call(actor, visit.id, fid, post("/x", body(actor, "current value")));

      const res = await getSection(actor, visit.id, "subj_complaints_habits");
      expect(res.status).toBe(200);
      expect(res.cache).toBe("no-store");
      expect(res.json.visitId).toBe(visit.id);
      const comments = res.json.fields?.find((f) => f.id === fid);
      expect(comments).toMatchObject({ version: 1, value: { freeText: "current value" }, isActive: true });
      expect(res.json.fields?.length).toBeGreaterThanOrEqual(20);
    });

    it("401 without a session, 403 without clinical.read (audited safely even for a nonexistent visit), 400 for bad ids, 404 for unknown visit/section", async () => {
      const { actor: doctor } = await createTestUser(db, { roleCode: "DOCTOR" });
      const { actor: reception } = await createTestUser(db, { roleCode: "RECEPTION" });
      const { visit } = await newVisit(doctor);

      expect((await getSection(null, visit.id, "subj_complaints_habits")).status).toBe(401);
      expect((await getSection(reception, visit.id, "subj_complaints_habits")).status).toBe(403);
      expect((await getSection(reception, randomUUID(), "subj_complaints_habits")).status).toBe(403);
      expect((await getSection(doctor, "not-a-uuid", "subj_complaints_habits")).status).toBe(400);
      expect((await getSection(doctor, visit.id, "Bad Section!")).status).toBe(400);
      expect((await getSection(doctor, randomUUID(), "subj_complaints_habits")).status).toBe(404);
      expect((await getSection(doctor, visit.id, "no_such_section")).status).toBe(404);
    });
  });
});
