import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { can, projectInstagramGrid, type Actor, type MediaAsset } from "@originpost/domain";
import { resolveBrandFilter } from "../common/brand-context.js";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import type { InstagramGridQueryDto } from "./instagram-grid.dto.js";

function preview(asset: MediaAsset) {
  return {
    mediaId: asset.id,
    kind: asset.kind as "image" | "video",
    contentType: asset.detectedContentType ?? asset.contentType,
    ...(asset.widthPixels !== undefined ? { widthPixels: asset.widthPixels } : {}),
    ...(asset.heightPixels !== undefined ? { heightPixels: asset.heightPixels } : {}),
    ...(asset.durationMs !== undefined ? { durationMs: asset.durationMs } : {}),
    ...(asset.altText ? { altText: asset.altText } : {}),
  };
}

@Injectable()
export class InstagramGridService {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure) {}

  async view(workspaceId: string, query: InstagramGridQueryDto, actor: Actor) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view the Instagram profile projection.");
    const brandId = await resolveBrandFilter(this.infrastructure.organizationRepository, workspaceId, query.brandId);
    const meta = { coverage: "originpost_records_only" as const, providerHistoryIncluded: false, storiesExcluded: true, limit: query.limit };
    if (!brandId) return { data: { accounts: [], selectedAccountId: null, tiles: [] }, meta };

    const connected = (await this.infrastructure.connectedAccountRepository.list(workspaceId, brandId))
      .filter((account) => account.platform === "instagram")
      .map((account) => ({ id: account.id, displayName: account.displayName, status: account.status }));
    const selected = query.accountId
      ? connected.find((account) => account.id === query.accountId)
      : connected.find((account) => account.status === "healthy") ?? connected[0];
    if (query.accountId && !selected) throw new NotFoundException("Instagram account not found for this brand.");
    if (!selected) return { data: { accounts: connected, selectedAccountId: null, tiles: [] }, meta };

    const projected = projectInstagramGrid(await this.infrastructure.repository.list(workspaceId, brandId), selected.id, query.limit);
    const hydrated = await Promise.all(projected.map(async (tile) => {
      if (!tile.previewMediaId) return tile;
      const asset = await this.infrastructure.mediaRepository.get(workspaceId, tile.previewMediaId);
      if (!asset || asset.brandId !== brandId || asset.status !== "ready" || (asset.kind !== "image" && asset.kind !== "video")) return tile;
      return { ...tile, preview: preview(asset) };
    }));
    return { data: { accounts: connected, selectedAccountId: selected.id, tiles: hydrated }, meta };
  }
}
