# Media organization

OriginPost organizes governed Media Assets without changing their stored bytes, rights, inspection result, SHA-256, content lineage, or lifecycle state. Organization metadata is brand-scoped and lives beside the immutable asset record.

## Library workflow

The **Library** supports:

- one folder per asset, with nested folders up to five levels deep;
- case-insensitive unique folder names among siblings;
- drag of one visible file onto a folder;
- multi-select bulk move to a folder or back to **Unfiled**;
- up to 20 normalized tags per asset;
- favorites, tag/type/folder filters, and search across file name, alt text, and tags;
- two-step deletion of an empty folder only.

Moving, tagging, or starring an asset does not publish, schedule, copy, transform, or delete provider media. A folder cannot be deleted while it contains files or child folders.

## Concurrency and atomicity

Every asset has a separate organization version. Browser mutations send the expected version for every selected asset. The API locks the complete selection and either applies the whole bulk change or none of it. A stale item therefore cannot produce a partially moved campaign.

Folder edits use the same optimistic version rule. PostgreSQL enforces workspace/brand lineage for folder parents and asset assignments; the repository also rejects cycles and moves that would exceed the five-level limit.

## HTTP surface

All routes require normal authentication, active workspace membership, and the exact brand context:

- `GET /v1/media-assets/library` — organized Library page with normalized assets, organization views, filters, and available tags;
- `GET /v1/media-assets/folders` — the brand folder tree with direct-file and child-folder counts;
- `POST /v1/media-assets/folders` — create a top-level or nested folder;
- `PATCH /v1/media-assets/folders/:id` — rename or move a folder using its expected version;
- `DELETE /v1/media-assets/folders/:id` — remove an empty folder using its expected version;
- `POST /v1/media-assets/organize` — atomically move, tag, untag, or change favorite state for one or more assets.

Viewers may read the Library. Creators, managers, and owners may organize assets under the existing `content:edit` permission. Object-storage keys and provider secrets are never part of these responses.

## Persistence

Migration `049_media_organization.sql` adds:

- `media_folders` for the brand-scoped hierarchy; and
- `media_asset_organization` for one folder, normalized tags, favorite state, and version per asset.

The Media Asset remains the source of truth for ownership, purpose, rights, storage, inspection, references, Trash, and retention. Organization rows cannot make an unsafe asset publishable and cannot bypass lifecycle reference checks.

