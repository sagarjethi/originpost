import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class ShareTargetInputDto {
  @IsOptional() @IsString() @MaxLength(180) title?: string;
  @IsOptional() @IsString() @MaxLength(4000) text?: string;
  @IsOptional() @IsString() @MaxLength(2048) url?: string;
}

export class ConvertShareCaptureDto extends ShareTargetInputDto {
  @IsString() @MaxLength(100) workspaceId!: string;
  @IsString() @MaxLength(100) brandId!: string;
}

export class MaterializeShareCaptureDto extends ConvertShareCaptureDto {
  @IsEnum(["creative", "evidence", "source"]) purpose!: "creative" | "evidence" | "source";
  @IsEnum(["unknown", "reference-only", "cleared", "owned"]) rights!: "unknown" | "reference-only" | "cleared" | "owned";
  @IsOptional() @IsString() @MaxLength(500) altText?: string;
  @IsEnum(["library", "content"]) mode!: "library" | "content";
  @IsOptional() @IsEnum(["instagram", "facebook", "youtube"]) platform?: "instagram" | "facebook" | "youtube";
  @IsOptional() @IsEnum(["image", "carousel", "reel", "story", "short", "text"]) format?: "image" | "carousel" | "reel" | "story" | "short" | "text";
  @IsOptional() @IsString() @MinLength(1) @MaxLength(10_000) caption?: string;
}
