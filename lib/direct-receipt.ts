type Receipt = { messageId: number; savedAt: number };
const memory = new Map<string, Receipt>();
const keyFor = (user: string, fileId: string) => `td:${user}:direct-receipt:${fileId}`;
const MAX_AGE = 24 * 60 * 60 * 1000;

export function readDirectReceipt(user: string, fileId: string): number | null {
  const key = keyFor(user, fileId);
  let receipt = memory.get(key);
  try { receipt ??= JSON.parse(localStorage.getItem(key) || "null"); } catch { /* storage unavailable */ }
  if (!receipt || !Number.isSafeInteger(receipt.messageId) || receipt.messageId <= 0 ||
      !Number.isFinite(receipt.savedAt) || receipt.savedAt > Date.now() || Date.now() - receipt.savedAt > MAX_AGE) return null;
  return receipt.messageId;
}

export function saveDirectReceipt(user: string, fileId: string, messageId: number) {
  const key = keyFor(user, fileId);
  const receipt = { messageId, savedAt: Date.now() };
  memory.set(key, receipt);
  try { localStorage.setItem(key, JSON.stringify(receipt)); } catch { /* keep the in-tab receipt */ }
}

export function clearDirectReceipt(user: string, fileId: string) {
  const key = keyFor(user, fileId);
  memory.delete(key);
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}
