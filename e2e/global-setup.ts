import "dotenv/config";
import { createDb } from "../src/db/client";
import { runMigrations } from "../src/db/migrator";
import { seed } from "../src/db/seed";
import { createTestUser } from "../test/helpers";
import type { RoleCode } from "../src/modules/permissions/constants";

export interface E2EUser {
  userId: string;
  email: string;
  password: string;
}

export type E2EUserKey = "doctor" | "doctor2" | "nurse" | "admin" | "reception" | "expiry";

const ROLE_FOR: Record<E2EUserKey, RoleCode> = {
  doctor: "DOCTOR",
  doctor2: "DOCTOR",
  nurse: "NURSE_ASSISTANT",
  admin: "ADMIN",
  reception: "RECEPTION",
  expiry: "DOCTOR",
};

/**
 * Migrates + seeds the database and creates one user per role for this run
 * (unique emails, so runs never collide). Credentials are handed to the tests
 * through process.env.E2E_USERS, which Playwright workers inherit.
 */
export default async function globalSetup(): Promise<void> {
  const url =
    process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Set E2E_DATABASE_URL (or TEST_DATABASE_URL / DATABASE_URL) for the E2E run.");
  }
  process.env.E2E_DATABASE_URL = url;

  await runMigrations(url);
  await seed(url);

  const { db, pool } = createDb(url);
  try {
    const users = {} as Record<E2EUserKey, E2EUser>;
    for (const key of Object.keys(ROLE_FOR) as E2EUserKey[]) {
      const created = await createTestUser(db, {
        roleCode: ROLE_FOR[key],
        displayName: `E2E ${key}`,
      });
      users[key] = { userId: created.userId, email: created.email, password: created.password };
    }
    process.env.E2E_USERS = JSON.stringify(users);
  } finally {
    await pool.end();
  }
}
