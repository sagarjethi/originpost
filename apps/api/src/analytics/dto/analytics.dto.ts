import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from "class-validator";
import { Type } from "class-transformer";

export class AnalyticsQueryDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsOptional() @IsString() @MaxLength(100) brandId?: string;
}

export class AnalyticsProofParamDto {
  @IsString() @MaxLength(120) contentItemId!: string;
  @IsString() @MaxLength(120) proofId!: string;
}

const reportMetrics = ["views", "engaged_views", "reach", "impressions", "clicks", "likes", "comments", "shares", "saves", "watch_time_seconds", "average_view_duration_seconds", "subscribers_gained"] as const;

export class CreateAnalyticsReportDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsString({ each: true }) brandIds!: string[];
  @IsEnum(["rolling", "fixed"]) rangeMode!: "rolling" | "fixed";
  @ValidateIf((value: CreateAnalyticsReportDto) => value.rangeMode === "rolling") @Type(() => Number) @IsInt() @Min(1) @Max(366) rollingDays?: number;
  @ValidateIf((value: CreateAnalyticsReportDto) => value.rangeMode === "fixed") @IsISO8601() from?: string;
  @ValidateIf((value: CreateAnalyticsReportDto) => value.rangeMode === "fixed") @IsISO8601() to?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @IsEnum(["instagram", "facebook", "youtube"], { each: true }) platforms!: Array<"instagram" | "facebook" | "youtube">;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) accountIds: string[] = [];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(reportMetrics.length) @IsEnum(reportMetrics, { each: true }) metricKeys!: typeof reportMetrics[number][];
}

export class AnalyticsReportQueryDto extends AnalyticsQueryDto {
  @IsOptional() @IsEnum(["true", "false"]) includeArchived?: "true" | "false";
}

export class AnalyticsReportParamDto {
  @IsString() @MinLength(8) @MaxLength(160) reportId!: string;
}

export class AnalyticsReportSnapshotParamDto extends AnalyticsReportParamDto {
  @IsString() @MinLength(8) @MaxLength(160) snapshotId!: string;
}

export class AnalyticsReportShareParamDto extends AnalyticsReportParamDto {
  @IsString() @MinLength(8) @MaxLength(160) snapshotId!: string;
  @IsString() @MinLength(8) @MaxLength(160) shareId!: string;
}

export class AnalyticsReportShareIdParamDto extends AnalyticsReportParamDto {
  @IsString() @MinLength(8) @MaxLength(160) shareId!: string;
}

export class CreateAnalyticsReportShareDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(90) expiresInDays = 14;
}

export class AnalyticsReportTokenParamDto {
  @IsString() @MinLength(32) @MaxLength(200) token!: string;
}
