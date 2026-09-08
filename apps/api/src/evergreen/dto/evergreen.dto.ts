import { Type } from "class-transformer";
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class EvergreenQueryDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsOptional() @IsString() @MaxLength(100) brandId?: string;
  @IsOptional() @IsIn(["active","paused","completed"]) status?: "active"|"paused"|"completed";
  @IsOptional() @Type(()=>Number) @IsInt() @Min(1) @Max(200) limit=100;
}
export class CreateEvergreenPolicyDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsString() @MaxLength(100) brandId!: string;
  @IsString() @MaxLength(160) sourceContentItemId!: string;
  @IsString() @MaxLength(160) sourceProofId!: string;
  @IsString() @MaxLength(120) name!: string;
  @IsIn(["review_first"]) mode!: "review_first";
  @Type(()=>Number) @IsInt() @Min(7) @Max(365) intervalDays!: number;
  @IsString() @MaxLength(80) timezone!: string;
  @IsDateString() firstPublishAt!: string;
  @IsDateString() endAt!: string;
  @Type(()=>Number) @IsInt() @Min(1) @Max(52) maxOccurrences!: number;
  @IsOptional() @IsString() @MaxLength(300) manualReason?: string;
}
