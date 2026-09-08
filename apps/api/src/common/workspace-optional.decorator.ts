import { SetMetadata } from "@nestjs/common";

export const WORKSPACE_OPTIONAL = "originpost:workspace-optional";
export const WorkspaceOptional = () => SetMetadata(WORKSPACE_OPTIONAL, true);
