import type { Metadata, Viewport } from "next";
import { PwaRuntime } from "@/components/pwa/pwa-runtime";
import "./globals.css";

export const metadata: Metadata = {
  title: "OriginPost — From source to published proof",
  description: "Evidence-backed social content operating system",
  applicationName: "OriginPost",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "OriginPost",
  },
  icons: {
    icon: [
      { url: "/icons/originpost-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/originpost-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/originpost-180.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#37413e",
  colorScheme: "light",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}<PwaRuntime /></body>
    </html>
  );
}
