import type { NextRequest } from "next/server";
import { apiDeps } from "@/app/api/_lib/deps";
import { getFileStorage } from "@/lib/file-storage-instance";
import { handleGetFile } from "@/modules/diagrams/api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ fileId: string }> }): Promise<Response> {
  return handleGetFile(await context.params, apiDeps(request), getFileStorage());
}
