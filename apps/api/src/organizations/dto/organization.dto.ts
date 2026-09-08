import { IsEnum, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from "class-validator";

export class WorkspaceParamDto {
  @IsString() @MinLength(1) @MaxLength(100) @Matches(/^[a-zA-Z0-9_-]+$/) workspaceId!: string;
}

export class BrandParamDto extends WorkspaceParamDto {
  @IsString() @MinLength(1) @MaxLength(100) @Matches(/^[a-zA-Z0-9_-]+$/) brandId!: string;
}

export class CreateWorkspaceDto {
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsOptional() @IsString() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @Length(1, 60) slug?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) defaultBrandName?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(40) primaryLanguage?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) timezone?: string;
}

export class UpdateWorkspaceDto {
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsOptional() @IsString() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @Length(1, 60) slug?: string;
}

export class CreateBrandDto {
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsOptional() @IsString() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @Length(1, 60) slug?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(40) primaryLanguage?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) timezone?: string;
}

export class UpdateBrandDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsOptional() @IsString() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @Length(1, 60) slug?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(40) primaryLanguage?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) timezone?: string;
  @IsOptional() @IsEnum(["active", "archived"]) status?: "active" | "archived";
}
