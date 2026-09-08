import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsEnum, IsInt, IsISO8601, IsOptional, IsString, Length, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
export class BatchWorkspaceQueryDto { @IsString() workspaceId = "default"; @IsOptional() @IsString() @MaxLength(100) brandId?: string; @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50 }
export class BatchIdParamDto { @IsString() @MinLength(8) @MaxLength(100) id!: string }
export class BatchYouTubeSettingsDto { @IsOptional() @IsEnum(["private", "unlisted", "public"]) privacyStatus: "private" | "unlisted" | "public" = "private"; @IsBoolean() madeForKids!: boolean; @IsBoolean() containsSyntheticMedia!: boolean; @IsOptional() @IsBoolean() notifySubscribers = false }
export class BatchInputRowDto {
  @IsString() @MaxLength(200) externalRef = "";
  @IsString() @MaxLength(180) title = ""; @IsOptional() @IsString() @MaxLength(2000) summary?: string;
  @IsOptional() @IsEnum(["quick", "standard", "deep"]) researchDepth: "quick" | "standard" | "deep" = "standard";
  @IsOptional() @IsEnum(["low", "medium", "high", "sensitive"]) riskLevel: "low" | "medium" | "high" | "sensitive" = "low";
  @IsEnum(["instagram", "facebook", "youtube"]) platform!: "instagram" | "facebook" | "youtube";
  @IsEnum(["image", "carousel", "reel", "story", "short", "text"]) format!: "image" | "carousel" | "reel" | "story" | "short" | "text";
  @IsString() @MaxLength(10000) caption = "";
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ArrayUnique() @IsString({ each: true }) mediaAssetIds: string[] = [];
  @IsOptional() @IsString() @MaxLength(200) accountId?: string; @IsOptional() @IsISO8601() scheduledFor?: string; @IsOptional() @IsString() @MaxLength(100) timezone?: string;
  @IsOptional() @IsEnum(["auto_publish", "manual_handoff"]) deliveryMode: "auto_publish" | "manual_handoff" = "auto_publish";
  @IsOptional() @ValidateNested() @Type(() => BatchYouTubeSettingsDto) youtubeSettings?: BatchYouTubeSettingsDto;
}
export class PreviewBatchDto { @IsString() workspaceId = "default"; @IsString() @MinLength(1) @MaxLength(100) brandId!: string; @IsString() @Length(2, 120) name!: string; @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => BatchInputRowDto) rows!: BatchInputRowDto[] }
export class BatchVersionDto { @IsString() workspaceId = "default"; @Type(() => Number) @IsInt() @Min(1) version!: number }
export class ApproveBatchDto extends BatchVersionDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique() @IsInt({ each: true }) rowNumbers!: number[]; @IsString() @MaxLength(40) confirmation!: string }
