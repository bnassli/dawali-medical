import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db/client";
import { parseDayMonthYear } from "@/lib/day-month-year";
import { searchPatientsSchema } from "@/modules/patients/schema";
import { createPatient, searchPatients, updatePatient } from "@/modules/patients/service";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

describe("birthdate as day/month/year (PS3)", () => {
  it("parses real dates to ISO and rejects impossible or unfinished ones", () => {
    expect(parseDayMonthYear("01/01/1925")).toBe("1925-01-01");
    expect(parseDayMonthYear(" 5/3/1996 ")).toBe("1996-03-05");
    expect(parseDayMonthYear("29/02/2024")).toBe("2024-02-29");
    expect(parseDayMonthYear("")).toBe("");
    for (const bad of ["31/02/1990", "29/02/2023", "12/13/2020", "1/1/25", "05/03", "1996-03-05", "aa/bb/cccc"]) {
      expect(parseDayMonthYear(bad), bad).toBeNull();
    }
  });
});

describe("search opens with the recent patients (PS1)", () => {
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

  it("an empty search still needs `recent: true`; recent lists the newest changes first", async () => {
    expect(searchPatientsSchema.safeParse({}).success).toBe(false);
    expect(searchPatientsSchema.safeParse({ recent: true }).success).toBe(true);

    const { actor } = await createTestUser(db, { roleCode: "RECEPTION" });
    const s = uniqueSuffix();
    const base = {
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    };
    const older = await createPatient(db, actor, { ...base, firstName: "Older", lastName: `Recent-${s}` });
    const newer = await createPatient(db, actor, { ...base, firstName: "Newer", lastName: `Recent-${s}` });

    let recent = await searchPatients(db, actor, { recent: true });
    expect(recent[0]?.id).toBe(newer.id);

    // Editing the older patient moves it to the top.
    await updatePatient(db, actor, {
      ...base,
      id: older.id,
      expectedVersion: older.version,
      firstName: "Older edited",
      lastName: older.lastName,
    });
    recent = await searchPatients(db, actor, { recent: true });
    expect(recent[0]?.id).toBe(older.id);
  });
});
