import type { NextRequest } from "next/server";
import { handleGetClinicalSection } from "@/modules/clinical/api";
import { apiDeps } from "@/app/api/_lib/deps";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ visitId: string; sectionCode: string }> },
): Promise<Response> {
  return handleGetClinicalSection(request, await context.params, apiDeps(request));
}
