import { createHash } from "node:crypto";
import { fetchPublicResource } from "./feed.js";
import {
  HermesSourcingProvider,
  type SourcingRequest,
  type SourcingResult,
} from "./research.js";

export type SourceRetrieval = {
  status: "matched" | "mismatch" | "unavailable";
  checkedAt: string;
  finalUrl?: string;
  sha256?: string;
  reason?: string;
  context?: string;
  contextSha256?: string;
  contextStart?: number;
  contextTruncated?: boolean;
};
const normalize = (text: string) =>
  text.normalize("NFC").replace(/\s+/gu, " ").trim();
export function sourcePageText(html: string) {
  return normalize(
    html
      .replace(
        /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
        " ",
      )
      .replace(/<!--[^]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(
        /&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,
        (_all, entity: string) => {
          const named: Record<string, string> = {
            amp: "&",
            quot: '"',
            apos: "'",
            lt: "<",
            gt: ">",
            nbsp: " ",
          };
          if (!entity.startsWith("#")) return named[entity.toLowerCase()]!;
          const value = entity.toLowerCase().startsWith("#x")
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
          return value > 0 && value <= 0x10ffff
            ? String.fromCodePoint(value)
            : " ";
        },
      ),
  );
}
export async function verifySourceExcerpts(
  result: SourcingResult,
  fetchPage = fetchPublicResource,
): Promise<SourcingResult> {
  const checkedAt = new Date().toISOString();
  const sources: SourcingResult["sources"] = [];
  const verified = new Set<string>();
  const signal = AbortSignal.timeout(45000);
  // Bound the entire evidence packet, including multi-source research, so the
  // writer and independent reviewer can receive the same retrieved context.
  const contextLimit = Math.min(12000, Math.floor(24000 / Math.max(1, result.sources.length)));
  for (let offset = 0; offset < result.sources.length; offset += 3) {
    sources.push(
      ...(await Promise.all(
        result.sources.slice(offset, offset + 3).map(async (source) => {
          let retrieval: SourceRetrieval;
          try {
            const page = await fetchPage(source.url, {
              maxBytes: 2 * 1024 * 1024,
              signal,
            });
            if (
              page.status < 200 ||
              page.status >= 300 ||
              !/(text\/html|application\/xhtml\+xml|text\/plain)/i.test(
                page.contentType,
              )
            )
              throw new Error("Page unavailable or unsupported content type.");
            const text = /text\/plain/i.test(page.contentType)
              ? normalize(page.body.toString("utf8"))
              : sourcePageText(page.body.toString("utf8"));
            const excerpt = normalize(source.excerpt ?? "");
            const matched = excerpt.length >= 30 && text.includes(excerpt);
            const contextStart = Math.max(0, Math.min(text.indexOf(excerpt) - Math.floor(contextLimit / 2), text.length - contextLimit));
            const context = text.slice(contextStart, contextStart + contextLimit);
            retrieval = {
              status: matched ? "matched" : "mismatch",
              checkedAt,
              finalUrl: page.url,
              sha256: createHash("sha256").update(page.body).digest("hex"),
              ...(matched ? {
                context,
                contextSha256: createHash("sha256").update(context).digest("hex"),
                contextStart,
                contextTruncated: context.length < text.length,
              } : {}),
              ...(!matched
                ? {
                    reason:
                      "The quoted excerpt was missing, too short, or not found in the retrieved page.",
                  }
                : {}),
            };
            if (matched) verified.add(source.url);
          } catch {
            retrieval = {
              status: "unavailable",
              checkedAt,
              reason:
                "The public page could not be retrieved for an independent excerpt check.",
            };
          }
          return {
            ...source,
            confidence:
              retrieval.status === "matched"
                ? Math.min(80, source.confidence)
                : 0,
            retrieval,
          };
        }),
      )),
    );
  }
  return {
    ...result,
    sources,
    claims: result.claims.map((claim) => ({
      ...claim,
      status:
        claim.status === "supported" &&
        (!claim.sourceUrls.length ||
          !claim.sourceUrls.every((url) => verified.has(url)))
          ? "unverified"
          : claim.status,
    })),
  };
}
export class LocalCodexSourcingProvider extends HermesSourcingProvider {
  override readonly id = "codex-local";
  override async research(request: SourcingRequest): Promise<SourcingResult> {
    const result = await super.research(request);
    if (!result.toolsUsed.includes("web_search"))
      throw new Error("Local Codex research returned no recorded web action.");
    return verifySourceExcerpts(result);
  }
}
