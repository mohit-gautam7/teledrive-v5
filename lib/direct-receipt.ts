/**
 * Which Telegram message(s) a direct upload already became, so a retry confirms
 * instead of uploading again. `messageIds` is used by files split into several
 * messages: one entry per finished piece, in order.
 */
type Receipt = { messageId?: number; messageIds?: number[]; savedAt: number };
const memory = new Map<string, Receipt>();
const keyFor = (user: string, fileId: string) => `td:${user}:direct-receipt:${fileId}`;
const MAX_AGE = 24 * 60 * 60 * 1000;
const validId = (id: unknown): id is number => Number.isSafeInteger(id) && (id as number) > 0;

function read(user: string, fileId: string): Receipt | null {
  const key = keyFor(user, fileId);
  let receipt = memory.get(key);
  try { receipt ??= JSON.parse(localStorage.getItem(key) || "null"); } catch { /* storage unavailable */ }
  if (!receipt || !Number.isFinite(receipt.savedAt) || receipt.savedAt > Date.now() || Date.now() - receipt.savedAt > MAX_AGE) return null;
  return receipt;
}

function write(user: string, fileId: string, receipt: Receipt) {
  const key = keyFor(user, fileId);
  memory.set(key, receipt);
  try { localStorage.setItem(key, JSON.stringify(receipt)); } catch { /* keep the in-tab receipt */ }
}

export function readDirectReceipt(user: string, fileId: string): number | null {
  const id = read(user, fileId)?.messageId;
  return validId(id) ? id : null;
}

export function saveDirectReceipt(user: string, fileId: string, messageId: number) {
  write(user, fileId, { messageId, savedAt: Date.now() });
}

/** Pieces of a split upload already in Telegram, in order. */
export function readDirectPieces(user: string, fileId: string): number[] {
  const ids = read(user, fileId)?.messageIds;
  return Array.isArray(ids) && ids.every(validId) ? ids : [];
}

export function saveDirectPieces(user: string, fileId: string, messageIds: number[]) {
  write(user, fileId, { messageIds, savedAt: Date.now() });
}

export function clearDirectReceipt(user: string, fileId: string) {
  const key = keyFor(user, fileId);
  memory.delete(key);
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}
