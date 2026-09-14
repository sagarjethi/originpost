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

export class CreateBoardTaskDto extends TestBoardDto {
  @IsString() @MinLength(1) @MaxLength(180) title!: string;
  @IsOptional() @IsString() @MaxLength(8_000) description?: string;
  @IsOptional() @IsIn(["low", "normal", "high", "urgent"]) priority?: "low" | "normal" | "high" | "urgent";
  @IsOptional() @IsIn(["team", "board-agent"]) assignee?: "team" | "board-agent";
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) parentTaskIds?: string[];
  @IsOptional() @IsString() @MaxLength(100) dueAt?: string;
}

export class UpdateBoardTaskDto extends TestBoardDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(180) title?: string;
  @IsOptional() @IsString() @MaxLength(8_000) description?: string;
  @IsOptional() @IsIn(["triage", "todo", "ready", "running", "blocked", "review", "done", "archived"]) status?: "triage" | "todo" | "ready" | "running" | "blocked" | "review" | "done" | "archived";
  @IsOptional() @IsIn(["low", "normal", "high", "urgent"]) priority?: "low" | "normal" | "high" | "urgent";
  @IsOptional() @IsIn(["team", "board-agent"]) assignee?: "team" | "board-agent";
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) parentTaskIds?: string[];
  @IsOptional() @IsString() @MaxLength(2_000) blockedReason?: string;
  @IsOptional() @IsString() @MaxLength(4_000) resultSummary?: string;
  @IsOptional() @IsString() @MaxLength(100) dueAt?: string | null;
}

export class ReleaseBoardTaskDto extends TestBoardDto {}

export class HandoffBoardTaskDto extends TestBoardDto {
  @IsString() @Matches(/^board_task_execution_[a-f0-9-]{36}$/u) executionId!: string;
}

export class BoardTaskCommentDto extends TestBoardDto {
  @IsString() @MinLength(1) @MaxLength(4_000) body!: string;
}

export class DecideBoardPendingWriteDto extends TestBoardDto {
  @IsIn(["approve", "reject"]) decision!: "approve" | "reject";
  @IsString() @Matches(/^[a-f0-9]{64}$/u) expectedSha256!: string;
}
