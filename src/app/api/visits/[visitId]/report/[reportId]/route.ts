import type { NextRequest } from "next/server";
import { apiDeps } from "@/app/api/_lib/deps";
import { getEnv } from "@/lib/env";
import { getFileStorage } from "@/lib/file-storage-instance";
import { handleSaveReport } from "@/modules/report-engine/api";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ visitId: string; reportId: string }> },
): Promise<Response> {
  return handleSaveReport(request, await context.params, apiDeps(request), getFileStorage(), getEnv().APP_TIME_ZONE);
}
