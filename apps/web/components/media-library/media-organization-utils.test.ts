import { describe, expect, it } from "vitest";
import { mediaMatchesOrganizationFilters, orderedMediaFolders, parseMediaTagInput } from "./media-organization-utils";

describe("media organization UI utilities", () => {
  it("orders nested folders without losing malformed or orphaned rows", () => {
    expect(orderedMediaFolders([
      { id: "child", parentId: "root", name: "Mumbai", version: 1, directAssetCount: 2, childFolderCount: 0 },
      { id: "root", name: "Campaigns", version: 1, directAssetCount: 0, childFolderCount: 1 },
      { id: "orphan", parentId: "missing", name: "Recovered", version: 1, directAssetCount: 0, childFolderCount: 0 },
    ])).toMatchObject([{ id: "root", depth: 0 }, { id: "child", depth: 1 }, { id: "orphan", depth: 0 }]);
  });

  it("combines search, folder, tag, favorite, and kind filters", () => {
    const asset = { fileName: "Mumbai Launch.JPG", altText: "Night event", kind: "image", organization: { folderId: "campaign", tags: ["launch", "mumbai"], favorite: true } };
    expect(mediaMatchesOrganizationFilters(asset, { search: "night", folder: "campaign", tag: "launch", kind: "image" })).toBe(true);
    expect(mediaMatchesOrganizationFilters(asset, { search: "", folder: "favorites", tag: "", kind: "video" })).toBe(false);
    const { folderId: _folderId, ...unfiledOrganization } = asset.organization;
    expect(mediaMatchesOrganizationFilters({ ...asset, organization: unfiledOrganization }, { search: "", folder: "unfiled", tag: "", kind: "" })).toBe(true);
  });

  it("normalizes comma-separated tags", () => {
    expect(parseMediaTagInput(" Launch, launch, Mumbai Event ")).toEqual(["launch", "mumbai event"]);
  });
});
