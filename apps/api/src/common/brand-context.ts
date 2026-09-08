import { DomainError, type OrganizationRepository } from "@originpost/domain";

export async function resolveActiveBrand(
  organizations: OrganizationRepository,
  workspaceId: string,
  requestedBrandId?: string,
): Promise<string> {
  const brands = await organizations.listBrands(workspaceId);
  const brandId = requestedBrandId ?? brands[0]?.id;
  if (!brandId || !brands.some((brand) => brand.id === brandId)) {
    throw new DomainError("The selected brand does not belong to this workspace.", "brand_not_found", 404);
  }
  return brandId;
}

export async function resolveBrandFilter(
  organizations: OrganizationRepository,
  workspaceId: string,
  requestedBrandId?: string,
): Promise<string | undefined> {
  if (requestedBrandId) return resolveActiveBrand(organizations, workspaceId, requestedBrandId);
  return (await organizations.listBrands(workspaceId))[0]?.id;
}
