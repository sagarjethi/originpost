import { SetMetadata } from "@nestjs/common";

export const ALLOW_SHARE_TARGET_POST = "originpost:allow-share-target-post";
export const AllowShareTargetPost = () => SetMetadata(ALLOW_SHARE_TARGET_POST, true);

