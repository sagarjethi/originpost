import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";

export class TrackedPublicSourceDto {
  @IsOptional() @IsString() @MaxLength(120) id?: string;
  @IsString() @MinLength(1) @MaxLength(120) label!: string;
  @IsString() @MinLength(8) @MaxLength(2048) url!: string;
  @IsIn(["rss_atom", "luma_city", "publisher_site", "public_profile"]) kind!: "rss_atom" | "luma_city" | "publisher_site" | "public_profile";
  @IsOptional() @IsString() @MaxLength(120) publisher?: string;
  @IsOptional() @IsIn(["primary", "trusted", "context"]) priority: "primary" | "trusted" | "context" = "trusted";
  @IsBoolean() enabled = true;
}

export class SourceIntelligenceDto {
  @IsIn(["tracked_sources"]) mode: "tracked_sources" = "tracked_sources";
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => TrackedPublicSourceDto) sources!: TrackedPublicSourceDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) includeTerms: string[] = [];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) excludeTerms: string[] = [];
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100) minimumScore = 45;
}

export class CreateMonitorDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId = "default";
  @IsOptional() @IsString() @MaxLength(100) brandId?: string;
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsString() @MinLength(3) @MaxLength(500) query!: string;
  @Type(() => Number) @IsInt() @Min(10) @Max(1440) intervalMinutes = 15;
  @IsEnum(["quick", "standard", "deep"]) depth: "quick" | "standard" | "deep" = "standard";
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(4) @IsString({ each: true }) languages: string[] = ["English"];
  @IsOptional() @IsString() @MaxLength(100) region?: string;
  @Type(() => Number) @IsInt() @Min(2) @Max(20) sourceLimit = 8;
  @Type(() => Number) @IsInt() @Min(1) @Max(8760) freshnessHours = 24;
  @IsBoolean() enabled = true;
  @IsOptional() @IsString() @MaxLength(200) notifyDestinationId?: string;
  @IsOptional() @ValidateNested() @Type(() => SourceIntelligenceDto) sourceIntelligence?: SourceIntelligenceDto;
}

export class UpdateMonitorDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(500) query?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(10) @Max(1440) intervalMinutes?: number;
  @IsOptional() @IsEnum(["quick", "standard", "deep"]) depth?: "quick" | "standard" | "deep";
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(4) @IsString({ each: true }) languages?: string[];
  @IsOptional() @IsString() @MaxLength(100) region?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(2) @Max(20) sourceLimit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(8760) freshnessHours?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(200) notifyDestinationId?: string;
  @IsOptional() @ValidateNested() @Type(() => SourceIntelligenceDto) sourceIntelligence?: SourceIntelligenceDto;
}
