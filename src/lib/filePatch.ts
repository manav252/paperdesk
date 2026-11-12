/** A file as stored, and a changed file as the browser sends it (`base`: hash of the version it was edited from). */
export type PatchFile = { name: string; content: string; encoding?: 'base64' };
export type FilePatch = { files: (PatchFile & { base?: string | null })[]; deleted?: string[] };

/**
 * Applies a save that carries only changed and deleted files to the stored list. A changed file whose stored
 * version no longer matches the one it was edited from (`base`; null means “was new”) is a conflict, so
 * two people editing different files never overwrite each other. Returns the new list, or the conflicting names.
 */
export function applyFilePatch(
  stored: PatchFile[],
  patch: FilePatch,
  hash: (content: string, encoding?: 'base64') => string,
) {
  const byName = new Map(stored.map((f) => [f.name, f]));
  const conflicts: string[] = [];
  for (const file of patch.files) {
    if (file.base === undefined) continue;
    const current = byName.get(file.name);
    const currentHash = current ? hash(current.content, current.encoding) : null;
    // Already saved with this exact content (a retried request) is not a conflict.
    if (currentHash !== file.base && currentHash !== hash(file.content, file.encoding)) conflicts.push(file.name);
  }
  if (conflicts.length) return { conflicts, files: stored };
  for (const name of patch.deleted ?? []) byName.delete(name);
  for (const { name, content, encoding } of patch.files)
    byName.set(name, encoding ? { name, content, encoding } : { name, content });
  return { conflicts, files: [...byName.values()] };
}
