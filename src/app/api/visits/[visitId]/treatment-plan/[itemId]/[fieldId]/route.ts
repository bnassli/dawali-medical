import type { NextRequest } from "next/server";
import { handleSaveTreatmentPlanCell } from "@/modules/clinical/api";
import { apiDeps } from "@/app/api/_lib/deps";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ visitId: string; itemId: string; fieldId: string }> },
): Promise<Response> {
  return handleSaveTreatmentPlanCell(request, await context.params, apiDeps(request));
}
