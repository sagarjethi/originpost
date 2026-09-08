import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, IsUrl, Length, Matches, Max, Min } from "class-validator";

export class MediaQueryDto {
  @IsString() workspaceId = "default";
  @IsOptional() @IsString() brandId?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(200) limit = 100;
}

export class CreateMediaUploadDto {
  @IsString() workspaceId = "default";
  @IsOptional() @IsString() brandId?: string;
  @IsOptional() @IsString() contentItemId?: string;
  @IsEnum(["image", "video", "audio", "document"]) kind!: "image" | "video" | "audio" | "document";
  @IsEnum(["creative", "evidence", "source"]) purpose!: "creative" | "evidence" | "source";
  @IsString() @Length(1, 180) fileName!: string;
  @IsString() @Length(3, 100) contentType!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(524_288_000) sizeBytes!: number;
  @Matches(/^[a-fA-F0-9]{64}$/) sha256!: string;
  @IsEnum(["unknown", "reference-only", "cleared", "owned"]) rights!: "unknown" | "reference-only" | "cleared" | "owned";
  @IsOptional() @IsString() @Length(1, 500) altText?: string;
  @IsOptional() @IsUrl({ require_protocol: true }) sourceUrl?: string;
}

export class CompleteMediaUploadDto { @IsString() workspaceId = "default" }
export class MediaMutationDto {
  @IsString() workspaceId = "default";
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}
export class MediaIdParamDto { @IsString() id!: string }
