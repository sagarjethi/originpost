import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  const value = {
    id: "/",
    name: "OriginPost — Social Content OS",
    short_name: "OriginPost",
    description: "Evidence-backed social content from source to published proof.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f5f1e8",
    theme_color: "#37413e",
    orientation: "any",
    categories: ["business", "productivity", "social"],
    share_target: {
      action: "/v1/share-captures/intake",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "title",
        text: "text",
        url: "url",
        files: [{
          name: "media",
          accept: ["image/jpeg", ".jpg", ".jpeg", "image/png", ".png", "image/webp", ".webp", "image/gif", ".gif", "video/mp4", ".mp4", "video/quicktime", ".mov", "video/webm", ".webm"],
        }],
      },
    },
    icons: [
      { src: "/icons/originpost-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/originpost-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/originpost-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return value as MetadataRoute.Manifest;
}
