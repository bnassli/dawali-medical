import type { NextRequest } from "next/server";
import { apiDeps } from "@/app/api/_lib/deps";
import { getEnv } from "@/lib/env";
import { fail, UUID_PATTERN } from "@/modules/clinical/api";
import { ConsumptionFilterError, consumptionWorkbook } from "@/modules/inventory/consumption-report";
import { ForbiddenError } from "@/modules/permissions/service";

export const dynamic = "force-dynamic";

/** I2: Excel export of materials used (ADR-037). GET only; audited; never cached. */
export async function GET(request: NextRequest): Promise<Response> {
  const deps = apiDeps(request);
  const actor = await deps.resolveActor();
  if (!actor) return fail(401, "unauthenticated", "Your session has expired. Sign in again.");
  const q = request.nextUrl.searchParams;
  const doctorId = q.get("doctor") || undefined;
  const warehouseId = q.get("store") || undefined;
  if ((doctorId && !UUID_PATTERN.test(doctorId)) || (warehouseId && !UUID_PATTERN.test(warehouseId))) {
    return fail(400, "invalid_input", "Invalid filter.");
  }
  try {
    const file = await consumptionWorkbook(
      deps.db,
      actor,
      { from: q.get("from") ?? "", to: q.get("to") ?? "", doctorId, warehouseId },
      getEnv().APP_TIME_ZONE,
    );
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${file.fileName}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return fail(403, "forbidden", err.message);
    if (err instanceof ConsumptionFilterError) return fail(400, "invalid_input", err.message);
    console.error("consumption export: unexpected error", err);
    return fail(500, "internal_error", "The export could not be created.");
  }
}
