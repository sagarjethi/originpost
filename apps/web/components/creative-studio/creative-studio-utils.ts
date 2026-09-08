export const creativeDimensions = {
  square: { width: 1080, height: 1080, label: "Square" },
  portrait: { width: 1080, height: 1350, label: "Portrait" },
  story: { width: 1080, height: 1920, label: "Story" },
} as const;

export type CreativeFormat = keyof typeof creativeDimensions;
export type CreativeLayout = "editorial" | "headline" | "quote";
export type CreativeFont = "manrope" | "newsreader";
export type CreativeTextAlign = "left" | "center";

export type CreativeSpec = {
  format: CreativeFormat;
  sourceMediaId: string;
  sourceMediaSha256: string;
  contentItemId?: string;
  kicker?: string;
  headline: string;
  subtitle?: string;
  footer?: string;
  layout: CreativeLayout;
  font: CreativeFont;
  textAlign: CreativeTextAlign;
  focalPoint: { x: number; y: number };
  zoom: number;
  palette: [string, string, string, string, string];
};

export type CreativeMediaAsset = {
  id: string;
  kind: "image" | "video" | "audio" | "document";
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  status: "pending" | "ready" | "rejected" | "trashed" | "expired" | "deleted" | "cleanup_failed";
  inspectionStatus?: "pending" | "ready" | "unavailable" | "failed" | "not_applicable";
  rights: "unknown" | "reference-only" | "cleared" | "owned";
  widthPixels?: number;
  heightPixels?: number;
  altText?: string;
};

export const defaultCreativeSpec: CreativeSpec = {
  format: "portrait",
  sourceMediaId: "",
  sourceMediaSha256: "",
  headline: "",
  layout: "editorial",
  font: "manrope",
  textAlign: "left",
  focalPoint: { x: 50, y: 50 },
  zoom: 1,
  palette: ["#2F3A34", "#F5F0E7", "#D86C4F", "#D5A94E", "#FFFFFF"],
};

export function isCreativeSource(asset: CreativeMediaAsset): boolean {
  return asset.kind === "image"
    && asset.status === "ready"
    && asset.inspectionStatus === "ready"
    && (asset.rights === "owned" || asset.rights === "cleared")
    && /^[a-f0-9]{64}$/u.test(asset.sha256);
}

export function canEditCreative(role: "owner" | "manager" | "creator" | "viewer" | undefined): boolean {
  return role === "owner" || role === "manager" || role === "creator";
}

export function creativeDraftTarget(format: CreativeFormat, platform: "instagram" | "facebook"): { platform: "instagram" | "facebook"; format: "image" | "story" } {
  return format === "story" ? { platform: "instagram", format: "story" } : { platform, format: "image" };
}

export function buildCreativeSpec(input: CreativeSpec): CreativeSpec {
  const optional = (value: string | undefined) => value?.normalize("NFC").trim() || undefined;
  const contentItemId = optional(input.contentItemId);
  const kicker = optional(input.kicker);
  const subtitle = optional(input.subtitle);
  const footer = optional(input.footer);
  return {
    format: input.format,
    sourceMediaId: input.sourceMediaId,
    sourceMediaSha256: input.sourceMediaSha256.toLowerCase(),
    ...(contentItemId ? { contentItemId } : {}),
    ...(kicker ? { kicker } : {}),
    headline: input.headline.normalize("NFC").trim(),
    ...(subtitle ? { subtitle } : {}),
    ...(footer ? { footer } : {}),
    layout: input.layout,
    font: input.font,
    textAlign: input.textAlign,
    focalPoint: {
      x: Math.min(100, Math.max(0, input.focalPoint.x)),
      y: Math.min(100, Math.max(0, input.focalPoint.y)),
    },
    zoom: Math.min(2, Math.max(1, input.zoom)),
    palette: input.palette.map((color) => color.toUpperCase()) as CreativeSpec["palette"],
  };
}

export function formatAssetBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
