import type { NextRequest } from "next/server";
import { apiDeps } from "@/app/api/_lib/deps";
import { getEnv } from "@/lib/env";
import { getFileStorage } from "@/lib/file-storage-instance";
import { handleSaveDiagram } from "@/modules/diagrams/api";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ visitId: string; diagramId: string }> },
): Promise<Response> {
  return handleSaveDiagram(request, await context.params, apiDeps(request), getFileStorage(), getEnv().APP_TIME_ZONE);
}
