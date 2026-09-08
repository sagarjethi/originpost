import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsEnum, IsInt, IsISO8601, IsOptional, IsString, IsUrl, Length, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { automationScopes, automationTopics, type AutomationScope, type AutomationTopic } from "@originpost/domain";
import { YouTubePublishSettingsDto } from "../content/dto/content.dto.js";

export class AutomationWorkspaceQueryDto { @IsString() @MaxLength(100) workspaceId = "default"; @Type(() => Number) @IsInt() @Min(1) @Max(200) limit = 100 }
export class AutomationIdParamDto { @IsString() @MinLength(8) @MaxLength(200) id!: string }

export class CreateAutomationKeyDto {
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ArrayUnique() @IsEnum(automationScopes, { each: true }) scopes!: AutomationScope[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ArrayUnique() @IsString({ each: true }) brandIds: string[] = [];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ArrayUnique() @IsString({ each: true }) accountIds: string[] = [];
  @IsOptional() @IsISO8601() expiresAt?: string;
}

export class CreateAutomationSubscriptionDto {
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsUrl({ protocols: ["http", "https"], require_protocol: true }) @MaxLength(2000) url!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(12) @ArrayUnique() @IsEnum(automationTopics, { each: true }) topics!: AutomationTopic[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ArrayUnique() @IsString({ each: true }) brandIds: string[] = [];
}

export class PublicContentQueryDto { @IsOptional() @IsString() @MaxLength(100) brandId?: string }
export class PublicCreateContentDto {
  @IsString() @MinLength(1) @MaxLength(180) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) summary?: string;
  @IsString() @MinLength(1) @MaxLength(100) brandId!: string;
  @IsOptional() @IsEnum(["quick", "standard", "deep"]) researchDepth: "quick" | "standard" | "deep" = "standard";
  @IsOptional() @IsEnum(["low", "medium", "high", "sensitive"]) riskLevel: "low" | "medium" | "high" | "sensitive" = "low";
}
export class PublicDraftDto {
  @IsEnum(["instagram", "facebook", "youtube"]) platform!: "instagram" | "facebook" | "youtube";
  @IsEnum(["image", "carousel", "reel", "story", "short", "text"]) format!: "image" | "carousel" | "reel" | "story" | "short" | "text";
  @IsString() @MinLength(1) @MaxLength(180) title!: string;
  @IsString() @MinLength(1) @MaxLength(10000) caption!: string;
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) mediaIds: string[] = [];
}
export class PublicScheduleDto {
  @IsEnum(["instagram", "facebook", "youtube"]) platform!: "instagram" | "facebook" | "youtube";
  @IsString() @MinLength(1) @MaxLength(200) accountId!: string;
  @IsString() @MinLength(1) @MaxLength(200) draftId!: string;
  @IsISO8601() scheduledFor!: string;
  @IsOptional() @IsString() @MaxLength(100) timezone?: string;
  @IsOptional() @IsEnum(["auto_publish", "manual_handoff"]) deliveryMode: "auto_publish" | "manual_handoff" = "auto_publish";
  @IsOptional() @IsString() @MaxLength(200) notifyDestinationId?: string;
  @IsOptional() @ValidateNested() @Type(() => YouTubePublishSettingsDto) settings?: YouTubePublishSettingsDto;
}
export class PublicRescheduleDto { @IsISO8601() scheduledFor!: string; @IsOptional() @IsString() @MaxLength(100) timezone?: string }

export class PublicImportRowDto {
  @IsOptional() @IsString() @MaxLength(500) externalRef?: string;
  @IsOptional() @IsString() @MaxLength(500) title?: string;
  @IsOptional() @IsString() @MaxLength(5000) summary?: string;
  @IsOptional() @IsString() @MaxLength(50) researchDepth?: string;
  @IsOptional() @IsString() @MaxLength(50) riskLevel?: string;
}
export class PublicImportPreviewDto {
  @IsEnum(["csv", "json"]) format!: "csv" | "json";
  @IsString() @MinLength(1) @MaxLength(100) brandId!: string;
  @IsOptional() @IsString() @MaxLength(500_000) data?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => PublicImportRowDto) rows?: PublicImportRowDto[];
}
