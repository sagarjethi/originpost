import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";

export class BoardQueryDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsString() @MinLength(1) @MaxLength(100) brandId!: string;
  @IsOptional() @Transform(({ value }) => value === true || value === "true") @IsBoolean() includeArchived = false;
  @IsOptional() @Type(()=>Number) @IsInt() @Min(1) @Max(100) limit = 50;
}

export class CreateBoardDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsString() @MinLength(1) @MaxLength(100) brandId!: string;
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsString() @MinLength(1) @MaxLength(600) purpose!: string;
}

export class UpdateBoardDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsString() @MinLength(1) @MaxLength(100) brandId!: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(600) purpose?: string;
  @IsOptional() @IsIn(["archived"]) status?: "archived";
}

export class UpdateBoardSkillDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsString() @MinLength(1) @MaxLength(100) brandId!: string;
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsBoolean() enabled!: boolean;
}

export class ReplaceBoardSkillsDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsString() @MinLength(1) @MaxLength(100) brandId!: string;
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) enabledSkills!: string[];
}

export class TestBoardDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsString() @MinLength(1) @MaxLength(100) brandId!: string;
}

export class RunBoardDto extends TestBoardDto {
  @IsString() @MinLength(1) @MaxLength(12_000) prompt!: string;
}

export class DecideBoardPendingWriteDto extends TestBoardDto {
  @IsIn(["approve", "reject"]) decision!: "approve" | "reject";
  @IsString() @Matches(/^[a-f0-9]{64}$/u) expectedSha256!: string;
}
