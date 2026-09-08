import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";

export class OutboxQueryDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId = "default";
  @IsOptional() @IsEnum(["pending", "processing", "processed", "failed"]) status?: "pending" | "processing" | "processed" | "failed";
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 25;
}

export class OperationIdParamDto {
  @IsString() @MinLength(3) @MaxLength(200) id!: string;
}
