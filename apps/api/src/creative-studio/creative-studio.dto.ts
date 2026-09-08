import { Type } from "class-transformer";
import { IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";

export class CreativeStudioQueryDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsOptional() @IsString() @MaxLength(100) brandId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit = 100;
}

export class CreateCreativeProjectDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsString() @MinLength(1) @MaxLength(100) brandId!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsObject() spec!: Record<string, unknown>;
}

export class AddCreativeRevisionDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsObject() spec!: Record<string, unknown>;
}

export class RenderCreativeRevisionDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
}
