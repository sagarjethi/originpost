import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Length, Max, Min, ValidateNested } from "class-validator";

const csv = ({ value }: { value: unknown }) => typeof value === "string" ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : value;
const bool = ({ value }: { value: unknown }) => value === true || value === "true" ? true : value === false || value === "false" ? false : value;

export class MediaOrganizationQueryDto {
  @IsString() workspaceId = "default";
  @IsOptional() @IsString() brandId?: string;
  @IsOptional() @IsEnum(["active", "trash", "history"]) view?: "active" | "trash" | "history";
  @IsOptional() @IsString() @Length(1, 120) search?: string;
  @IsOptional() @IsString() folderId?: string;
  @IsOptional() @Transform(bool) @IsBoolean() unfiled?: boolean;
  @IsOptional() @Transform(bool) @IsBoolean() favorite?: boolean;
  @IsOptional() @Transform(csv) @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsEnum(["image", "video", "audio", "document"]) kind?: "image" | "video" | "audio" | "document";
  @Type(() => Number) @IsInt() @Min(1) @Max(200) limit = 100;
}

export class CreateMediaFolderDto {
  @IsString() workspaceId = "default";
  @IsOptional() @IsString() brandId?: string;
  @IsOptional() @IsString() parentId?: string;
  @IsString() @Length(1, 80) name!: string;
}

export class UpdateMediaFolderDto {
  @IsString() workspaceId = "default";
  @IsOptional() @IsString() brandId?: string;
  @Type(() => Number) @IsInt() @Min(1) version!: number;
  @IsString() @Length(1, 80) name!: string;
  @IsOptional() @IsString() parentId?: string | null;
}

export class DeleteMediaFolderQueryDto {
  @IsString() workspaceId = "default";
  @IsOptional() @IsString() brandId?: string;
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}

export class MediaBulkAssetDto {
  @IsString() assetId!: string;
  @Type(() => Number) @IsInt() @Min(0) expectedVersion!: number;
}

export class BulkOrganizeMediaDto {
  @IsString() workspaceId = "default";
  @IsOptional() @IsString() brandId?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => MediaBulkAssetDto) assets!: MediaBulkAssetDto[];
  @IsOptional() @IsString() folderId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) addTags?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) removeTags?: string[];
  @IsOptional() @IsBoolean() favorite?: boolean;
}

export class MediaFolderIdParamDto { @IsString() id!: string; }
