import { ArrayMaxSize, IsArray, IsEnum, IsISO8601, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

const platforms = ["instagram", "facebook", "youtube"] as const;
const capabilities = ["profile_read", "page_read", "media_publish", "channel_read", "video_upload", "analytics_read", "comment_read", "comment_reply"] as const;

export class CreateConnectedAccountDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId = "default";
  @IsOptional() @IsString() @MaxLength(100) brandId?: string;
  @IsEnum(platforms) platform!: "instagram" | "facebook" | "youtube";
  @IsString() @MinLength(1) @MaxLength(100) displayName!: string;
  @IsString() @MinLength(1) @MaxLength(180) externalAccountId!: string;
  @IsOptional() @IsString() @MaxLength(240) @Matches(/^(env|vault|secret):[A-Za-z0-9._:/-]+$/, { message: "credentialRef must be an env:, vault:, or secret: reference, never a raw token" }) credentialRef?: string;
  @IsArray() @ArrayMaxSize(8) @IsEnum(capabilities, { each: true }) capabilities: Array<(typeof capabilities)[number]> = [];
  @IsOptional() @IsISO8601() expiresAt?: string;
}

export class UpdateConnectedAccountDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) displayName?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(180) externalAccountId?: string;
  @IsOptional() @IsString() @MaxLength(240) @Matches(/^(env|vault|secret):[A-Za-z0-9._:/-]+$/, { message: "credentialRef must be an env:, vault:, or secret: reference, never a raw token" }) credentialRef?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsEnum(capabilities, { each: true }) capabilities?: Array<(typeof capabilities)[number]>;
  @IsOptional() @IsISO8601() expiresAt?: string;
}
