export type MobileShareReceiptMedia = {
  kind: "image" | "video";
  fileName: string;
  declaredContentType: string;
  sizeBytes: number;
  sha256: string;
  inspectionStatus: "pending" | "ready" | "failed" | "unavailable";
  detectedContentType?: string;
  widthPixels?: number;
  heightPixels?: number;
  durationMs?: number;
  inspectedAt?: string;
  inspector?: string;
  errorCode?: string;
  errorSummary?: string;
};

export type MobileShareDraftChoice = {
  value: string;
  platform: "instagram" | "facebook" | "youtube";
  format: "image" | "reel" | "story" | "short";
  label: string;
};

export function mobileShareDraftChoices(media: MobileShareReceiptMedia | undefined): MobileShareDraftChoice[] {
  if (!media || media.inspectionStatus !== "ready") return [];
  const ratio = media.widthPixels && media.heightPixels ? media.widthPixels / media.heightPixels : 0;
  const exactStory = Math.abs(ratio - 9 / 16) < 0.01;
  if (media.kind === "image") {
    const values: MobileShareDraftChoice[] = [
      { value: "instagram:image", platform: "instagram", format: "image", label: "Instagram image post" },
      { value: "facebook:image", platform: "facebook", format: "image", label: "Facebook image post" },
    ];
    if (exactStory && media.detectedContentType === "image/jpeg") values.push({ value: "instagram:story", platform: "instagram", format: "story", label: "Instagram Story · exact 9:16 JPEG" });
    return values;
  }
  const values: MobileShareDraftChoice[] = [{ value: "instagram:reel", platform: "instagram", format: "reel", label: "Instagram Reel" }];
  if (exactStory && (media.durationMs ?? Number.POSITIVE_INFINITY) >= 3_000 && (media.durationMs ?? 0) <= 60_000) values.push({ value: "instagram:story", platform: "instagram", format: "story", label: "Instagram Story · 3–60s, exact 9:16" });
  if (ratio > 0 && ratio <= 1 && (media.durationMs ?? Number.POSITIVE_INFINITY) <= 180_000) values.push({ value: "youtube:short", platform: "youtube", format: "short", label: "YouTube Short · square/vertical, ≤180s" });
  return values;
}
