import { Body, Controller, Get, Header, Param, Post } from "@nestjs/common";
import { Public } from "../common/public.decorator.js";
import { ContentService } from "./content.service.js";
import { ExternalReviewCommentDto, ReviewTokenParamDto } from "./dto/content.dto.js";

@Public()
@Controller({ path: "reviews", version: "1" })
export class ReviewController {
  constructor(private readonly content: ContentService) {}

  @Get(":token") @Header("Cache-Control", "no-store") view(@Param() params: ReviewTokenParamDto) {
    return this.content.externalReview(params.token);
  }

  @Post(":token/comments") @Header("Cache-Control", "no-store") comment(@Param() params: ReviewTokenParamDto, @Body() dto: ExternalReviewCommentDto) {
    return this.content.externalReviewComment(params.token, dto);
  }
}
