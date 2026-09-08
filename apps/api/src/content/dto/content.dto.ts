import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsISO8601, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, MinLength, Validate, ValidateNested, ValidatorConstraint, type ValidationArguments, type ValidatorConstraintInterface } from "class-validator";
import { calendarExportTargetStatuses, type CalendarExportTargetStatus } from "@originpost/domain";

const platforms = ["instagram", "facebook", "youtube"] as const;
const formats = ["image", "carousel", "reel", "story", "short", "text"] as const;

@ValidatorConstraint({ name: "facebookPageDraftContract", async: false })
class FacebookPageDraftContractConstraint implements ValidatorConstraintInterface {
  validate(mediaIds: unknown, args: ValidationArguments): boolean {
    const draft = args.object as Partial<AddDraftDto>;
    if (draft.platform !== "facebook") return true;
    if (!Array.isArray(mediaIds)) return false;
    if (draft.format === "text") return mediaIds.length === 0;
    if (draft.format === "image") return mediaIds.length === 1;
    return false;
  }

  defaultMessage(args: ValidationArguments): string {
    const draft = args.object as Partial<AddDraftDto>;
    if (draft.format === "text") return "A Facebook Page text post cannot include media.";
    if (draft.format === "image") return "A Facebook Page image post must include exactly one image.";
    return "Facebook Pages currently support text posts and single-image posts only.";
  }
}

export class WorkspaceQueryDto { @IsOptional() @IsString() @MaxLength(100) workspaceId?: string; @IsOptional() @IsString() @MaxLength(100) brandId?: string }
export class ScheduleExportQueryDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsString() @MinLength(1) @MaxLength(100) brandId!: string;
  @IsString() @Matches(/^\d{4}-(?:0[1-9]|1[0-2])$/) month!: string;
  @IsString() @MinLength(1) @MaxLength(100) timeZone!: string;
  @IsOptional() @IsEnum(["all", ...platforms]) platform: "all" | "instagram" | "facebook" | "youtube" = "all";
  @IsOptional() @IsEnum(["all", ...calendarExportTargetStatuses]) status: "all" | CalendarExportTargetStatus = "all";
}
export class IdParamDto { @IsString() @MinLength(3) @MaxLength(200) id!: string }
export class TargetParamDto extends IdParamDto { @IsString() @MinLength(3) @MaxLength(200) targetId!: string }
export class ReviewLinkParamDto extends IdParamDto { @IsString() @MinLength(3) @MaxLength(200) linkId!: string }
export class ReviewTokenParamDto { @IsString() @MinLength(20) @MaxLength(2000) token!: string }

export class CreateContentDto {
  @IsOptional() @IsString() @MinLength(8) @MaxLength(100) contentId?: string;
  @IsOptional() @IsString() @MaxLength(100) workspaceId = "default";
  @IsOptional() @IsString() @MaxLength(100) brandId?: string;
  @IsString() @MinLength(1) @MaxLength(180) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) summary?: string;
  @IsOptional() @IsEnum(["quick", "standard", "deep"]) researchDepth: "quick" | "standard" | "deep" = "standard";
  @IsOptional() @IsEnum(["low", "medium", "high", "sensitive"]) riskLevel: "low" | "medium" | "high" | "sensitive" = "low";
}

export class AddSourceDto {
  @IsEnum(["url", "note", "image", "video", "document", "voice", "screenshot"]) kind!: "url" | "note" | "image" | "video" | "document" | "voice" | "screenshot";
  @IsString() @MinLength(1) @MaxLength(240) title!: string;
  @IsOptional() @IsUrl() url?: string;
  @IsOptional() @IsString() @MaxLength(120) publisher?: string;
  @IsOptional() @IsISO8601() publishedAt?: string;
  @IsOptional() @Matches(/^[a-fA-F0-9]{64}$/) sha256?: string;
  @IsOptional() @IsEnum(["unknown", "reference-only", "cleared", "owned"]) rights: "unknown" | "reference-only" | "cleared" | "owned" = "unknown";
  @IsOptional() @Type(() => Number) @Min(0) @Max(100) confidence = 50;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class ResearchDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(500) query?: string;
  @IsOptional() @IsEnum(["quick", "standard", "deep"]) depth?: "quick" | "standard" | "deep";
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(4) @IsString({ each: true }) languages: string[] = ["English"];
  @IsOptional() @IsString() @MaxLength(100) region?: string;
  @Type(() => Number) @IsInt() @Min(2) @Max(20) sourceLimit = 6;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(8760) freshnessHours?: number;
}

export class AddDraftDto {
  @IsEnum(platforms) platform!: "instagram" | "facebook" | "youtube";
  @IsEnum(formats) format!: "image" | "carousel" | "reel" | "story" | "short" | "text";
  @IsString() @MinLength(1) @MaxLength(180) title!: string;
  @IsString() @MinLength(1) @MaxLength(10000) caption!: string;
  @IsArray() @IsString({ each: true }) @Validate(FacebookPageDraftContractConstraint) mediaIds: string[] = [];
}

export class AgentDraftDto {
  @IsEnum(platforms) platform!: "instagram" | "facebook" | "youtube";
  @IsEnum(formats) format!: "image" | "carousel" | "reel" | "story" | "short" | "text";
  @IsString() @MinLength(2) @MaxLength(40) language = "English";
  @IsOptional() @IsString() @MaxLength(2000) instruction?: string;
}

export class ApprovalDto {
  @IsEnum(["approved", "changes-requested", "rejected"]) decision!: "approved" | "changes-requested" | "rejected";
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsString() @MaxLength(200) draftId?: string;
}

export class ReviewCommentDto {
  @IsString() @MinLength(1) @MaxLength(200) draftId!: string;
  @IsEnum(["internal", "reviewer", "public"]) audience!: "internal" | "reviewer" | "public";
  @IsString() @MinLength(1) @MaxLength(3000) body!: string;
}

export class CreateReviewLinkDto {
  @IsString() @MinLength(1) @MaxLength(200) draftId!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(720) expiresInHours = 72;
  @IsOptional() @IsBoolean() allowComment = true;
}

export class ExternalReviewCommentDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsString() @MinLength(1) @MaxLength(3000) body!: string;
}

export class TransitionDto { @IsEnum(["inbox", "researching", "drafting", "review", "approved", "scheduled", "action_required", "publishing", "published", "failed", "archived"]) to!: "inbox" | "researching" | "drafting" | "review" | "approved" | "scheduled" | "action_required" | "publishing" | "published" | "failed" | "archived"; @IsOptional() @IsString() @MaxLength(500) reason?: string }

export class YouTubePublishSettingsDto {
  @IsString() @MinLength(1) @MaxLength(100) @Matches(/^[^<>]+$/u) title!: string;
  @IsString() @MaxLength(5000) @Matches(/^[^<>]*$/u) description!: string;
  @IsOptional() @IsEnum(["private", "unlisted", "public"]) privacyStatus: "private" | "unlisted" | "public" = "private";
  @IsBoolean() madeForKids!: boolean;
  @IsBoolean() containsSyntheticMedia!: boolean;
  @IsOptional() @IsBoolean() notifySubscribers = false;
  @IsOptional() @IsString() @Matches(/^\d+$/) @MaxLength(20) categoryId?: string;
  @IsOptional() @IsString() @Matches(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/) @MaxLength(35) defaultLanguage?: string;
  @IsOptional() @IsString() @MaxLength(100) timezone?: string;
}

export class ScheduleDto {
  @IsOptional() @IsString() @MinLength(8) @MaxLength(100) targetId?: string;
  @IsEnum(platforms) platform!: "instagram" | "facebook" | "youtube";
  @IsString() @MinLength(1) accountId!: string;
  @IsString() @MinLength(1) draftId!: string;
  @IsISO8601() scheduledFor!: string;
  @IsOptional() @IsString() @MaxLength(100) timezone?: string;
  @IsOptional() @IsEnum(["auto_publish", "manual_handoff"]) deliveryMode: "auto_publish" | "manual_handoff" = "auto_publish";
  @IsOptional() @IsString() @MaxLength(200) notifyDestinationId?: string;
  @IsOptional() @ValidateNested() @Type(() => YouTubePublishSettingsDto) settings?: YouTubePublishSettingsDto;
  /** Instagram collaborators are resolved server-side from this approved immutable candidate. */
  @IsOptional() @IsString() @MinLength(8) @MaxLength(200) instagramCollaboratorApprovalId?: string;
  /** Preferred name for the exact approved collaborators, feed choice, and Reel cover. */
  @IsOptional() @IsString() @MinLength(8) @MaxLength(200) instagramPublishApprovalId?: string;
  /** Exact hash returned by the current read-only scheduling conflict preflight. */
  @IsOptional() @IsString() @Matches(/^[0-9a-f]{64}$/) conflictAcknowledgementSha256?: string;
}

export class SchedulePreflightDto extends ScheduleDto {
  @IsOptional() @IsString() @MinLength(8) @MaxLength(200) excludeTargetId?: string;
}

export class RescheduleTargetDto {
  @IsISO8601() scheduledFor!: string;
  @IsOptional() @IsString() @MaxLength(100) timezone?: string;
  @IsOptional() @IsString() @Matches(/^[0-9a-f]{64}$/) conflictAcknowledgementSha256?: string;
}

export class ManualPublishConfirmationDto {
  @IsString() @MinLength(1) @MaxLength(300) externalPostId!: string;
  @IsUrl({ protocols: ["http", "https"], require_protocol: true }) liveUrl!: string;
  @IsISO8601() publishedAt!: string;
  @IsOptional() @IsEnum(["none", "ai-assisted", "synthetic-media"]) disclosure: "none" | "ai-assisted" | "synthetic-media" = "none";
  @IsOptional() @IsUrl({ protocols: ["http", "https"], require_protocol: true }) screenshotUrl?: string;
}
