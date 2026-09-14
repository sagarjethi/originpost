import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from "class-validator";
import { imageGenerationQualities, imageGenerationSizes, imageGenerationVisualIntents, type ImageGenerationQuality, type ImageGenerationSize, type ImageGenerationVisualIntent } from "@originpost/domain";

export class ImageGenerationQueryDto {
  @IsString() workspaceId = "default";
  @IsOptional() @IsString() brandId?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(200) limit = 50;
}

export class CreateImageGenerationDto {
  @IsString() workspaceId = "default";
  @IsOptional() @IsString() brandId?: string;
  @IsOptional() @IsString() contentItemId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsString({ each: true }) referenceMediaIds?: string[];
  @IsString() @Length(1, 8_000) prompt!: string;
  @IsEnum(imageGenerationVisualIntents) visualIntent!: ImageGenerationVisualIntent;
  @IsEnum(imageGenerationSizes) size: ImageGenerationSize = "1024x1536";
  @IsEnum(imageGenerationQualities) quality: ImageGenerationQuality = "medium";
  @IsString() @Length(1, 500) altText!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) sourceEvidenceIds: string[] = [];
}
