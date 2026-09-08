import { createHmac, timingSafeEqual } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DomainError } from "@originpost/domain";

export interface ReviewTokenPayload {
  version: 1;
  linkId: string;
  workspaceId: string;
  contentItemId: string;
  draftId: string;
  draftSha256: string;
  expiresAt: string;
}

@Injectable()
export class ReviewTokenService {
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.secret = config.get<string>("REVIEW_LINK_SECRET") ?? "development-review-secret-change-before-sharing";
  }

  sign(payload: ReviewTokenPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${encoded}.${this.signature(encoded)}`;
  }

  verify(token: string): ReviewTokenPayload {
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra) throw this.invalid();
    const expected = Buffer.from(this.signature(encoded));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw this.invalid();
    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<ReviewTokenPayload>;
      if (payload.version !== 1 || !payload.linkId || !payload.workspaceId || !payload.contentItemId || !payload.draftId || !payload.draftSha256 || !payload.expiresAt) throw this.invalid();
      return payload as ReviewTokenPayload;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw this.invalid();
    }
  }

  private signature(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("base64url");
  }

  private invalid(): DomainError {
    return new DomainError("This review link is invalid or no longer available.", "review_link_invalid", 404);
  }
}
