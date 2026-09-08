import type { ContentFormat, MediaInspectionStatus, MediaMalwareScanStatus, Platform, RightsState } from "./types.js";

export interface MeasuredPublishMedia {
  id: string;
  type: "image" | "video";
  /** Server-inspected MIME type when available; Story images fail closed without JPEG. */
  mimeType?: string | undefined;
  inspectionStatus: MediaInspectionStatus;
  malwareScanStatus?: MediaMalwareScanStatus | undefined;
  widthPixels?: number | undefined;
  heightPixels?: number | undefined;
  durationMs?: number | undefined;
  rights?: RightsState | undefined;
}

export interface MediaPolicyIssue {
  field: "media";
  code: string;
  message: string;
  severity: "error";
}

export interface MediaPolicyInput {
  platform: Platform;
  format: ContentFormat;
  media: readonly MeasuredPublishMedia[];
}

function issue(code: string, message: string): MediaPolicyIssue {
  return { field: "media", code, message, severity: "error" };
}

function hasImageShape(media: MeasuredPublishMedia): boolean {
  return media.type === "image"
    && Number.isInteger(media.widthPixels) && media.widthPixels! > 0
    && Number.isInteger(media.heightPixels) && media.heightPixels! > 0;
}

function hasVideoShape(media: MeasuredPublishMedia): boolean {
  return media.type === "video"
    && Number.isInteger(media.widthPixels) && media.widthPixels! > 0
    && Number.isInteger(media.heightPixels) && media.heightPixels! > 0
    && Number.isInteger(media.durationMs) && media.durationMs! > 0;
}

/**
 * One stable product seam for trusted media facts and release-format rules.
 * Provider adapters can add changing provider limits without duplicating the
 * server-measurement requirement.
 */
export function validateMeasuredMedia(input: MediaPolicyInput): MediaPolicyIssue[] {
  const issues: MediaPolicyIssue[] = [];
  const malwareSafe = input.media.every((media) => media.malwareScanStatus === undefined || media.malwareScanStatus === "clean" || media.malwareScanStatus === "disabled");
  if (input.media.length > 0 && !malwareSafe) {
    issues.push(issue("media_malware_scan_required", "Every attached image or video must pass server-side malware scanning before publishing."));
    return issues;
  }
  const measured = input.media.every((media) => media.inspectionStatus === "ready"
    && (media.type === "image" ? hasImageShape(media) : hasVideoShape(media)));
  if (input.media.length > 0 && !measured) {
    issues.push(issue("media_inspection_required", "Every attached image or video must have trusted server-measured metadata before publishing."));
    return issues;
  }

  if (input.platform === "instagram") {
    if (input.format === "image" && (input.media.length !== 1 || input.media[0]?.type !== "image")) {
      issues.push(issue("instagram_image_required", "An Instagram image post needs exactly one image."));
    }
    if (input.format === "carousel" && (input.media.length < 2 || input.media.length > 10)) {
      issues.push(issue("instagram_carousel_count", "An Instagram carousel needs 2 to 10 media files."));
    }
    if (input.format === "reel" && (input.media.length !== 1 || input.media[0]?.type !== "video")) {
      issues.push(issue("instagram_reel_video_required", "An Instagram Reel needs exactly one video."));
    }
    if (input.format === "story") {
      const story = input.media[0];
      if (input.media.length !== 1 || (story?.type !== "image" && story?.type !== "video")) {
        issues.push(issue("instagram_story_media_required", "An Instagram Story needs exactly one image or video."));
      } else {
        if (story.rights !== "cleared" && story.rights !== "owned") {
          issues.push(issue("instagram_story_rights_required", "An Instagram Story needs media with owned or cleared publishing rights."));
        }
        if (story.type === "image" && story.mimeType !== "image/jpeg") {
          issues.push(issue("instagram_story_image_must_be_jpeg", "Instagram Story images must be server-inspected JPEG files."));
        }
        if (story.widthPixels! * 16 !== story.heightPixels! * 9) {
          issues.push(issue("instagram_story_aspect_ratio", "Instagram Story media must use the release-safe 9:16 aspect ratio."));
        }
        if (story.type === "video") {
          if (story.durationMs! < 3_000) issues.push(issue("instagram_story_video_too_short", "An Instagram Story video must be at least 3 seconds long."));
          if (story.durationMs! > 60_000) issues.push(issue("instagram_story_video_too_long", "An Instagram Story video must be 60 seconds or shorter."));
        }
      }
    }
  }

  if (input.platform === "facebook") {
    if (input.format === "text" && input.media.length !== 0) {
      issues.push(issue("facebook_text_has_media", "A Facebook text post cannot include media."));
    }
    if (input.format === "image" && (input.media.length !== 1 || input.media[0]?.type !== "image")) {
      issues.push(issue("facebook_image_required", "A Facebook image post needs exactly one image."));
    }
  }

  if (input.platform === "youtube" && input.format === "short") {
    const video = input.media[0];
    if (input.media.length !== 1 || video?.type !== "video") {
      issues.push(issue("youtube_short_video_required", "A YouTube Short needs exactly one video."));
    } else {
      if (video.durationMs! > 180_000) issues.push(issue("youtube_short_too_long", "A YouTube Short must be 3 minutes or shorter."));
      if (video.widthPixels! > video.heightPixels!) issues.push(issue("youtube_short_not_vertical", "A YouTube Short must use a square or vertical video."));
    }
  }

  return issues;
}
