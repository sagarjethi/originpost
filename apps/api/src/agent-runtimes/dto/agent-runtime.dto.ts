import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUrl, ValidateIf, Max, MaxLength, Min, MinLength } from "class-validator";

export class AgentRuntimeQueryDto { @IsOptional() @IsString() @MaxLength(100) workspaceId?:string; @IsOptional() @IsString() @MaxLength(100) brandId?:string; @IsOptional() @Type(()=>Number) @IsInt() @Min(1) @Max(200) limit=50; }
export class CreateAgentRuntimeDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?:string;
  @IsString() @MinLength(2) @MaxLength(100) name!:string;
  @IsIn(["openai","openrouter","ollama","custom","codex-local"]) preset!:"openai"|"openrouter"|"ollama"|"custom"|"codex-local";
  @IsOptional() @IsUrl({protocols:["http","https"],require_protocol:true}) @MaxLength(500) baseUrl?:string;
  @IsString() @MinLength(1) @MaxLength(160) textModel!:string;
  @ValidateIf((_object, value) => value !== undefined) @IsString() @MaxLength(160) visionModel?:string;
  @IsOptional() @IsString() @MaxLength(1000) apiKey?:string;
  @IsOptional() @IsString() @MaxLength(100) assignBrandId?:string;
}
export class UpdateAgentRuntimeDto { @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?:string; @IsOptional() @IsUrl({protocols:["http","https"],require_protocol:true}) @MaxLength(500) baseUrl?:string; @IsOptional() @IsString() @MinLength(1) @MaxLength(160) textModel?:string; @ValidateIf((_object, value) => value !== undefined) @IsString() @MaxLength(160) visionModel?:string; @IsOptional() @IsString() @MaxLength(1000) apiKey?:string; @IsOptional() @IsBoolean() disabled?:boolean; }
export class AssignAgentRuntimeDto { @IsOptional() @IsString() @MaxLength(100) workspaceId?:string; @IsString() @MinLength(1) @MaxLength(100) brandId!:string; }
