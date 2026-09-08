import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_ROUTE = "originpost:is-public";
export const Public = () => SetMetadata(IS_PUBLIC_ROUTE, true);
