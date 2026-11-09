export const CURRENT_ORDER_KEY = "paytrace.currentMerchantOrderId";

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readCurrentOrderId(storage: BrowserStorage): string | null {
  try {
    const value = storage.getItem(CURRENT_ORDER_KEY);
    return value?.startsWith("ord_") ? value : null;
  } catch {
    return null;
  }
}

export function storeCurrentOrderId(storage: BrowserStorage, merchantOrderId: string): void {
  if (!merchantOrderId.startsWith("ord_")) return;
  try { storage.setItem(CURRENT_ORDER_KEY, merchantOrderId); } catch { /* Storage is optional. */ }
}

export function clearCurrentOrderId(storage: BrowserStorage): void {
  try { storage.removeItem(CURRENT_ORDER_KEY); } catch { /* Storage is optional. */ }
}
