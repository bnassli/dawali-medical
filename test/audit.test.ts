import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs } from "@/db/schema";
import { writeAudit } from "@/modules/audit/service";
import { openTestDb } from "./helpers";

describe("audit_logs append-only", () => {
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

  it("rejects UPDATE at the database level via trigger", async () => {
    await writeAudit(db, {
      actorUserId: null,
      action: "test.append_only_probe",
      entityType: "test",
      entityId: "probe-update",
    });

    const [row] = await db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.entityId} = 'probe-update'`)
      .limit(1);
    expect(row).toBeDefined();

    await expect(
      db.execute(sql`UPDATE audit_logs SET action = 'tampered' WHERE id = ${row?.id}`),
    ).rejects.toThrow(/append-only/i);
  });

  it("rejects DELETE at the database level via trigger", async () => {
    await writeAudit(db, {
      actorUserId: null,
      action: "test.append_only_probe",
      entityType: "test",
      entityId: "probe-delete",
    });

    const [row] = await db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.entityId} = 'probe-delete'`)
      .limit(1);
    expect(row).toBeDefined();

    await expect(
      db.execute(sql`DELETE FROM audit_logs WHERE id = ${row?.id}`),
    ).rejects.toThrow(/append-only/i);
  });
});
