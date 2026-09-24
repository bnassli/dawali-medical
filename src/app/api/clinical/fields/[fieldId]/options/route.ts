import type { NextRequest } from "next/server";
import { handleAddClinicalOption } from "@/modules/clinical/api";
import { apiDeps } from "@/app/api/_lib/deps";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ fieldId: string }> },
): Promise<Response> {
  return handleAddClinicalOption(request, await context.params, apiDeps(request));
}
