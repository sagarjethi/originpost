export type MediaFolderOption = { id: string; parentId?: string; name: string; version: number; directAssetCount: number; childFolderCount: number };

export function orderedMediaFolders(folders: readonly MediaFolderOption[]): Array<MediaFolderOption & { depth: number }> {
  const children = new Map<string | undefined, MediaFolderOption[]>();
  for (const folder of folders) children.set(folder.parentId, [...(children.get(folder.parentId) ?? []), folder]);
  for (const values of children.values()) values.sort((a, b) => a.name.localeCompare(b.name, "en"));
  const ordered: Array<MediaFolderOption & { depth: number }> = [];
  const visit = (parentId: string | undefined, depth: number, seen: Set<string>) => {
    for (const folder of children.get(parentId) ?? []) {
      if (seen.has(folder.id)) continue;
      ordered.push({ ...folder, depth });
      visit(folder.id, depth + 1, new Set([...seen, folder.id]));
    }
  };
  visit(undefined, 0, new Set());
  for (const folder of folders) if (!ordered.some((entry) => entry.id === folder.id)) ordered.push({ ...folder, depth: 0 });
  return ordered;
}

export function mediaMatchesOrganizationFilters(input: { fileName: string; altText?: string; kind: string; organization: { folderId?: string; tags: string[]; favorite: boolean } }, filters: { search: string; folder: string; tag: string; kind: string }): boolean {
  const haystack = `${input.fileName} ${input.altText ?? ""} ${input.organization.tags.join(" ")}`.normalize("NFKC").toLocaleLowerCase("en-US");
  const search = filters.search.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  return (!search || haystack.includes(search))
    && (filters.folder === "all" || filters.folder === "unfiled" && !input.organization.folderId || filters.folder === "favorites" && input.organization.favorite || input.organization.folderId === filters.folder)
    && (!filters.tag || input.organization.tags.includes(filters.tag))
    && (!filters.kind || input.kind === filters.kind);
}

export function parseMediaTagInput(value: string): string[] {
  return [...new Set(value.split(",").map((entry) => entry.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US")).filter(Boolean))].slice(0, 20);
}
