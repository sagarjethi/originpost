import { Type } from "class-transformer";
import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { YouTubePublishSettingsDto } from "../content/dto/content.dto.js";

export class PostingQueueQueryDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsString() @MinLength(1) @MaxLength(100) brandId!: string;
}
export class PostingQueuePreviewQueryDto extends PostingQueueQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30) count = 7;
}
export class PostingQueueProfileDto {
  @IsBoolean() enabled!: boolean;
  @IsString() @MinLength(1) @MaxLength(100) timezone!: string;
  @IsObject() weeklySlots!: Record<string, string[]>;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) expectedVersion?: number;
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsString() @MinLength(1) @MaxLength(100) brandId!: string;
}
export class PostingQueueDraftPreviewDto extends PostingQueueProfileDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30) count = 7;
}
export class ScheduleNextDto {
  @IsString() @MinLength(1) @MaxLength(200) draftId!: string;
  @IsString() @MinLength(1) @MaxLength(200) connectedAccountId!: string;
  @IsEnum(["auto_publish", "manual_handoff"]) deliveryMode: "auto_publish" | "manual_handoff" = "auto_publish";
  @IsOptional() @IsString() @MaxLength(200) notifyDestinationId?: string;
  @Type(() => Number) @IsInt() @Min(1) expectedProfileVersion!: number;
  @IsOptional() @IsString() @MinLength(8) @MaxLength(200) instagramPublishApprovalId?: string;
  @IsOptional() @ValidateNested() @Type(() => YouTubePublishSettingsDto) settings?: YouTubePublishSettingsDto;
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsString() @MinLength(1) @MaxLength(100) brandId!: string;
  @IsOptional() @IsString() @Matches(/^[0-9a-f]{64}$/) conflictAcknowledgementSha256?: string;
}
export class QueueAccountParamDto { @IsString() @MinLength(3) @MaxLength(200) connectedAccountId!: string; }
export class QueueContentParamDto { @IsString() @MinLength(3) @MaxLength(200) contentItemId!: string; }
