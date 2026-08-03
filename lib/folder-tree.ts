/**
 * Folder sizes and counts, rolled up through the tree.
 *
 * A folder's tile shows what is *inside* it, which includes everything nested
 * below — so each folder's own aggregate is summed with its descendants'. Done
 * in one pass over an in-memory tree rather than a query per folder, and shared
 * by /api/folders and the batched /api/overview so the two cannot disagree.
 */

export type FolderRow = { id: string; name: string; parentId: string | null; createdAt: Date };

export type FolderAggregate = { folderId: string | null; _sum: { size: bigint | null }; _count: { _all: number } };

export type PublicFolder = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
  size: number;
  fileCount: number;
};

export function rollUpFolders(folders: FolderRow[], grouped: FolderAggregate[]): PublicFolder[] {
  const direct = new Map<string, { size: number; count: number }>();
  for (const g of grouped) {
    if (g.folderId) direct.set(g.folderId, { size: Number(g._sum.size ?? 0), count: g._count._all });
  }

  const childrenOf = new Map<string, string[]>();
  for (const folder of folders) {
    const key = folder.parentId ?? "__root__";
    const list = childrenOf.get(key) ?? [];
    list.push(folder.id);
    childrenOf.set(key, list);
  }

  const memo = new Map<string, { size: number; count: number }>();
  // Iterative rather than recursive: a folder whose parent chain loops — which
  // no code path creates today, but a bad row could — would recurse until the
  // stack gave out, and the whole listing would 500 with it.
  const rollUp = (id: string) => {
    const cached = memo.get(id);
    if (cached) return cached;

    const order: string[] = [];
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      order.push(current);
      for (const child of childrenOf.get(current) ?? []) if (!seen.has(child)) stack.push(child);
    }

    // Deepest first, so every child is settled before its parent is summed.
    for (let i = order.length - 1; i >= 0; i--) {
      const current = order[i];
      if (memo.has(current)) continue;
      const own = direct.get(current) ?? { size: 0, count: 0 };
      let size = own.size;
      let count = own.count;
      for (const child of childrenOf.get(current) ?? []) {
        const sub = memo.get(child);
        if (sub) {
          size += sub.size;
          count += sub.count;
        }
      }
      memo.set(current, { size, count });
    }

    return memo.get(id) ?? { size: 0, count: 0 };
  };

  return folders
    .map(folder => {
      const totals = rollUp(folder.id);
      return {
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId,
        createdAt: folder.createdAt,
        size: totals.size,
        fileCount: totals.count
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
