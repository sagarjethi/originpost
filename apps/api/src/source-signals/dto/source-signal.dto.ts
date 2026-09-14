import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class SourceSignalQueryDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsOptional() @IsString() @MaxLength(100) brandId?: string;
  @IsOptional() @IsIn(["new", "saving", "saved", "dismissed"]) state?: "new" | "saving" | "saved" | "dismissed";
  @IsOptional() @IsString() @MaxLength(160) monitorId?: string;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000) offset = 0;
  @IsOptional() @IsIn(["priority", "newest", "discovered"]) sort: "priority" | "newest" | "discovered" = "priority";
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(8760) recentHours?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit = 100;
}

export class DismissSourceSignalDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
