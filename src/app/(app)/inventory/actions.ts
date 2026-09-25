"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { getDb } from "@/db/client";
import type { ExtractedInvoice } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { getFileStorage } from "@/lib/file-storage-instance";
import { requireActor } from "@/modules/auth/current-actor";
import { VisitNotOpenError } from "@/modules/clinical/service";
import { AnthropicInvoiceExtractor } from "@/modules/inventory/extractor";
import {
  adjustStock,
  consumeForVisit,
  InventoryError,
  receiveStock,
  scanInvoice,
  transferStock,
  type ReceiveInput,
} from "@/modules/inventory/service";
import { ForbiddenError } from "@/modules/permissions/service";

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

function failure(err: unknown): ActionResult {
  if (err instanceof ZodError) return { ok: false, message: err.issues[0]?.message ?? "Check the form." };
  if (err instanceof InventoryError || err instanceof VisitNotOpenError) return { ok: false, message: err.message };
  if (err instanceof ForbiddenError) return { ok: false, message: "You do not have permission to do this." };
  console.error("inventory action failed", err);
  return { ok: false, message: "Something went wrong; nothing was saved." };
}

export async function scanInvoiceAction(
  formData: FormData,
): Promise<{ ok: true; scanId: string; extracted: ExtractedInvoice | null; error: string | null } | { ok: false; message: string }> {
  const actor = await requireActor();
  const file = formData.get("scan");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose the scanned invoice first." };
  const env = getEnv();
  const extractor = env.ANTHROPIC_API_KEY ? new AnthropicInvoiceExtractor(env.ANTHROPIC_API_KEY, env.INVOICE_AI_MODEL) : null;
  try {
    const r = await scanInvoice(getDb(), getFileStorage(), extractor, actor, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      fileName: file.name,
      contentType: file.type,
    });
    return { ok: true, ...r };
  } catch (err) {
    return failure(err) as { ok: false; message: string };
  }
}

export async function receiveAction(input: ReceiveInput): Promise<ActionResult> {
  const actor = await requireActor();
  try {
    await receiveStock(getDb(), actor, input);
    revalidatePath("/inventory");
    return { ok: true, message: `Invoice ${input.invoiceNumber} received into stock.` };
  } catch (err) {
    return failure(err);
  }
}

export async function adjustAction(input: Parameters<typeof adjustStock>[2]): Promise<ActionResult> {
  const actor = await requireActor();
  try {
    await adjustStock(getDb(), actor, input);
    revalidatePath("/inventory");
    return { ok: true, message: "Stock adjusted." };
  } catch (err) {
    return failure(err);
  }
}

export async function transferAction(input: Parameters<typeof transferStock>[2]): Promise<ActionResult> {
  const actor = await requireActor();
  try {
    await transferStock(getDb(), actor, input);
    revalidatePath("/inventory");
    return { ok: true, message: "Transferred." };
  } catch (err) {
    return failure(err);
  }
}

export async function consumeAction(input: Parameters<typeof consumeForVisit>[2], path: string): Promise<ActionResult> {
  const actor = await requireActor();
  try {
    await consumeForVisit(getDb(), actor, input);
    revalidatePath(path);
    return { ok: true, message: "Recorded." };
  } catch (err) {
    return failure(err);
  }
}
