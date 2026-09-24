import type { NextRequest } from "next/server";
import { handleSaveClinicalEntry } from "@/modules/clinical/api";
import { apiDeps } from "@/app/api/_lib/deps";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ visitId: string; fieldId: string }> },
): Promise<Response> {
  return handleSaveClinicalEntry(request, await context.params, apiDeps(request));
}
