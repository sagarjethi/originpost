import { DomainError } from "./errors.js";

export const facebookPageDraftFormats = ["text", "image"] as const;

export type FacebookPageDraftFormat = (typeof facebookPageDraftFormats)[number];

export type FacebookPageDraftContractIssue = {
  code: "facebook_page_format_unsupported" | "facebook_page_media_invalid";
  path: "format" | "mediaIds";
  message: string;
};

/**
 * First-release Facebook Page contract: a text-only post has no media and a
 * single-image post has exactly one media asset. Other Page formats stay
 * closed until their provider workflows have durable recovery coverage.
 */
export function facebookPageDraftContractIssue(input: {
  platform: string;
  format: string;
  mediaIds: readonly string[];
}): FacebookPageDraftContractIssue | null {
  if (input.platform !== "facebook") return null;

  if (!facebookPageDraftFormats.includes(input.format as FacebookPageDraftFormat)) {
    return {
      code: "facebook_page_format_unsupported",
      path: "format",
      message: "Facebook Pages currently support text posts and single-image posts only.",
    };
  }

  if (input.format === "text" && input.mediaIds.length !== 0) {
    return {
      code: "facebook_page_media_invalid",
      path: "mediaIds",
      message: "A Facebook Page text post cannot include media.",
    };
  }

  if (input.format === "image" && input.mediaIds.length !== 1) {
    return {
      code: "facebook_page_media_invalid",
      path: "mediaIds",
      message: "A Facebook Page image post must include exactly one image.",
    };
  }

  return null;
}

export function assertFacebookPageDraftContract(input: {
  platform: string;
  format: string;
  mediaIds: readonly string[];
}): void {
  const issue = facebookPageDraftContractIssue(input);
  if (issue) throw new DomainError(issue.message, issue.code);
}
