export type BackupFolder = { id: string; name?: string; parentId: string | null };

export function descendantFolderIds(root: string, folders: BackupFolder[]) {
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parentId) continue;
    const list = children.get(folder.parentId) ?? [];
    list.push(folder.id); children.set(folder.parentId, list);
  }
  const seen = new Set<string>(), stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id); stack.push(...(children.get(id) ?? []));
  }
  return [...seen];
}
