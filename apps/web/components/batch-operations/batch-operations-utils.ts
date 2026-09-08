export type BatchPlatform = "instagram" | "facebook" | "youtube";
export type BatchRiskLevel = "low" | "medium" | "high" | "sensitive";
export type BatchAssetInput = { id: string; fileName: string; kind: "image" | "video" };

export function cleanBatchFileStem(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function addBatchMinutes(value: string, minutes: number) {
  return new Date(new Date(value).getTime() + minutes * 60_000).toISOString();
}

function safeExternalPart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "batch";
}

export function buildBatchRows(assets: readonly BatchAssetInput[], options: {
  batchName: string;
  platform: BatchPlatform;
  captionTemplate: string;
  accountId?: string;
  startAtIso: string;
  intervalMinutes: number;
  timezone: string;
  riskLevel: BatchRiskLevel;
  madeForKids: boolean;
  containsSyntheticMedia: boolean;
}) {
  return assets.map((asset, index) => {
    const title = cleanBatchFileStem(asset.fileName);
    const format = options.platform === "youtube" ? "short" : asset.kind === "video" ? "reel" : "image";
    return {
      externalRef: `${safeExternalPart(options.batchName)}:${safeExternalPart(asset.id)}`,
      title,
      summary: `Prepared from ${asset.fileName}`,
      researchDepth: "standard" as const,
      riskLevel: options.riskLevel,
      platform: options.platform,
      format,
      caption: options.captionTemplate.replaceAll("{filename}", title),
      mediaAssetIds: [asset.id],
      ...(options.accountId ? { accountId: options.accountId, scheduledFor: addBatchMinutes(options.startAtIso, index * options.intervalMinutes), timezone: options.timezone } : {}),
      deliveryMode: "auto_publish" as const,
      ...(options.platform === "youtube" && options.accountId ? { youtubeSettings: { privacyStatus: "private" as const, madeForKids: options.madeForKids, containsSyntheticMedia: options.containsSyntheticMedia, notifySubscribers: false } } : {}),
    };
  });
}
