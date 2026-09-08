import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class StartOAuthDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId = "default";
  @IsOptional() @IsString() @MaxLength(100) brandId?: string;
}

export class InstagramOAuthCallbackDto {
  @IsString() @MinLength(16) @MaxLength(512) state!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(2048) code?: string;
  @IsOptional() @IsString() @MaxLength(120) error?: string;
  @IsOptional() @IsString() @MaxLength(500) error_description?: string;
}

export class FacebookSelectionParamDto { @IsString() @MinLength(20) @MaxLength(200) selectionId!: string; }
export class FacebookSelectionDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId = "default";
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each: true }) pageIds!: string[];
}

export class InstagramFacebookSelectionDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId = "default";
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each:true }) instagramAccountIds!: string[];
}

export class MetaMessagingSelectionDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId = "default";
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each:true }) targetKeys!: string[];
}
