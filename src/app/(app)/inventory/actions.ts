"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { ZodError } from "zod";
import { getDb } from "@/db/client";
import type { ExtractedInvoice } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { getFileStorage } from "@/lib/file-storage-instance";
import { requireActor } from "@/modules/auth/current-actor";
import { VisitNotOpenError } from "@/modules/clinical/service";
import { postStockCount, saveProduct, type ProductInput, type StockCountInput } from "@/modules/inventory/catalog";
import { AnthropicInvoiceExtractor } from "@/modules/inventory/extractor";
import { DICTS, fill, LANG_COOKIE, parseLang, type Dict, type DictKey } from "@/modules/inventory/i18n";
import {
  adjustStock,
  consumeForVisit,
  InsufficientStockError,
  InventoryError,
  receiveStock,
  scanInvoice,
  transferStock,
  type ReceiveInput,
} from "@/modules/inventory/service";
import { ForbiddenError } from "@/modules/permissions/service";

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

async function dict(): Promise<Dict> {
  return DICTS[parseLang((await cookies()).get(LANG_COOKIE)?.value)];
}

function failure(d: Dict, err: unknown): ActionResult {
  if (err instanceof ZodError) return { ok: false, message: fill(d.checkForm, { m: err.issues[0]?.message ?? "" }) };
  if (err instanceof InsufficientStockError) return { ok: false, message: fill(d.notEnough, { n: err.available, unit: err.unit }) };
  if (err instanceof InventoryError) {
    const key = `err_${err.key ?? ""}`;
    return { ok: false, message: key in d ? d[key as DictKey] : err.message };
  }
  if (err instanceof VisitNotOpenError) return { ok: false, message: err.message };
  if (err instanceof ForbiddenError) return { ok: false, message: d.forbidden };
  console.error("inventory action failed", err);
  return { ok: false, message: d.failed };
}

/** Switch the inventory screens between Arabic and English (per browser, one year). */
export async function setLanguageAction(lang: string): Promise<void> {
  await requireActor();
  (await cookies()).set(LANG_COOKIE, parseLang(lang), { path: "/", sameSite: "lax", httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
  revalidatePath("/inventory", "layout");
}

export async function scanInvoiceAction(
  formData: FormData,
): Promise<{ ok: true; scanId: string; extracted: ExtractedInvoice | null; error: string | null } | { ok: false; message: string }> {
  const actor = await requireActor();
  const d = await dict();
  const file = formData.get("scan");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: d.chooseScan };
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
    return failure(d, err) as { ok: false; message: string };
  }
}

export async function receiveAction(input: ReceiveInput): Promise<ActionResult> {
  const actor = await requireActor();
  const d = await dict();
  try {
    await receiveStock(getDb(), actor, input);
    revalidatePath("/inventory", "layout");
    return { ok: true, message: fill(d.received, { n: input.invoiceNumber }) };
  } catch (err) {
    return failure(d, err);
  }
}

export async function adjustAction(input: Parameters<typeof adjustStock>[2]): Promise<ActionResult> {
  const actor = await requireActor();
  const d = await dict();
  try {
    await adjustStock(getDb(), actor, input);
    revalidatePath("/inventory", "layout");
    return { ok: true, message: d.adjusted };
  } catch (err) {
    return failure(d, err);
  }
}

export async function transferAction(input: Parameters<typeof transferStock>[2]): Promise<ActionResult> {
  const actor = await requireActor();
  const d = await dict();
  try {
    await transferStock(getDb(), actor, input);
    revalidatePath("/inventory", "layout");
    return { ok: true, message: d.transferred };
  } catch (err) {
    return failure(d, err);
  }
}

export async function saveProductAction(input: ProductInput): Promise<ActionResult> {
  const actor = await requireActor();
  const d = await dict();
  try {
    await saveProduct(getDb(), actor, input);
    revalidatePath("/inventory", "layout");
    return { ok: true, message: d.saved };
  } catch (err) {
    return failure(d, err);
  }
}

export async function stockCountAction(input: StockCountInput): Promise<ActionResult> {
  const actor = await requireActor();
  const d = await dict();
  try {
    const r = await postStockCount(getDb(), actor, input);
    revalidatePath("/inventory", "layout");
    return { ok: true, message: fill(d.countPosted, { lines: r.lines, changes: r.changes }) };
  } catch (err) {
    return failure(d, err);
  }
}

/** Used from the visit screen (clinical side, English). */
export async function consumeAction(input: Parameters<typeof consumeForVisit>[2], path: string): Promise<ActionResult> {
  const actor = await requireActor();
  try {
    await consumeForVisit(getDb(), actor, input);
    revalidatePath(path);
    return { ok: true, message: "Recorded." };
  } catch (err) {
    return failure(DICTS.en, err);
  }
}
