import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs, sessions } from "@/db/schema";
import { hashSessionToken } from "@/lib/session-token";
import { AuthenticationError, login, logout, validateSession } from "@/modules/auth/service";
import { proxy } from "@/proxy";
import { SESSION_COOKIE_NAME } from "@/modules/auth/cookie";
import { createTestUser, openTestDb, uniqueEmail } from "./helpers";

describe("auth", () => {
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

  it("logs in successfully and audits auth.login", async () => {
    const user = await createTestUser(db, { roleCode: "RECEPTION" });

    const result = await login(db, { email: user.email, password: user.password }, {
      ip: "10.0.0.1",
      userAgent: "vitest",
    });

    expect(result.userId).toBe(user.userId);
    expect(result.token).toBeTypeOf("string");
    expect(result.token.length).toBeGreaterThan(20);

    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "auth.login"), eq(auditLogs.actorUserId, user.userId)))
      .orderBy(desc(auditLogs.id));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("rejects wrong password with a generic error and audits auth.login_failed", async () => {
    const user = await createTestUser(db, { roleCode: "RECEPTION" });

    await expect(
      login(db, { email: user.email, password: "totally-wrong-password" }, {}),
    ).rejects.toBeInstanceOf(AuthenticationError);

    const rows = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, "auth.login_failed"), eq(auditLogs.actorUserId, user.userId)),
      );
    expect(rows.length).toBeGreaterThan(0);

    // The failed-login audit metadata must never contain the submitted password.
    for (const row of rows) {
      expect(JSON.stringify(row.metadata ?? {})).not.toContain("totally-wrong-password");
    }
  });

  it("rejects an unknown email with the same generic error and audits it", async () => {
    const email = uniqueEmail("nobody");
    await expect(
      login(db, { email, password: "whatever123" }, {}),
    ).rejects.toBeInstanceOf(AuthenticationError);

    const rows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "auth.login_failed"))
      .orderBy(desc(auditLogs.id))
      .limit(5);
    expect(rows.some((r) => r.entityId === email)).toBe(true);
  });

  it("inactive users cannot log in", async () => {
    const user = await createTestUser(db, { roleCode: "RECEPTION", isActive: false });

    await expect(
      login(db, { email: user.email, password: user.password }, {}),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("validateSession rejects a missing token", async () => {
    const actor = await validateSession(db, undefined);
    expect(actor).toBeNull();
    const actor2 = await validateSession(db, "");
    expect(actor2).toBeNull();
  });

  it("validateSession rejects an unknown/garbage token", async () => {
    const actor = await validateSession(db, "not-a-real-token-at-all");
    expect(actor).toBeNull();
  });

  it("validateSession rejects an expired session", async () => {
    const user = await createTestUser(db, { roleCode: "RECEPTION" });
    const token = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({
      userId: user.userId,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() - 60_000), // already expired
    });

    const actor = await validateSession(db, token);
    expect(actor).toBeNull();
  });

  it("validateSession rejects a revoked session", async () => {
    const user = await createTestUser(db, { roleCode: "RECEPTION" });
    const token = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({
      userId: user.userId,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: new Date(),
    });

    const actor = await validateSession(db, token);
    expect(actor).toBeNull();
  });

  it("validateSession accepts a fresh, non-revoked, non-expired session", async () => {
    const user = await createTestUser(db, { roleCode: "RECEPTION" });
    const result = await login(db, { email: user.email, password: user.password }, {});

    const actor = await validateSession(db, result.token);
    expect(actor).not.toBeNull();
    expect(actor?.userId).toBe(user.userId);
  });

  it("logout revokes the session (subsequent validation fails) and audits auth.logout", async () => {
    const user = await createTestUser(db, { roleCode: "RECEPTION" });
    const result = await login(db, { email: user.email, password: user.password }, {});

    await logout(db, result.token, {});

    const actor = await validateSession(db, result.token);
    expect(actor).toBeNull();

    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "auth.logout"), eq(auditLogs.actorUserId, user.userId)));
    expect(rows.length).toBeGreaterThan(0);
  });

  describe("proxy (edge route guard)", () => {
    it("redirects to /login when there is no session cookie", () => {
      const request = new NextRequest(new URL("http://localhost/patients"));
      const response = proxy(request);
      expect(response.status).toBeGreaterThanOrEqual(300);
      expect(response.status).toBeLessThan(400);
      expect(response.headers.get("location")).toContain("/login");
    });

    it("passes the request through when a session cookie is present", () => {
      const request = new NextRequest(new URL("http://localhost/patients"), {
        headers: { cookie: `${SESSION_COOKIE_NAME}=some-token-value` },
      });
      const response = proxy(request);
      expect(response.headers.get("location")).toBeNull();
    });
  });
});
