import { randomUUID } from "node:crypto";
import { deriveBoardRuntimeSecrets, type BoardRuntimePort } from "@originpost/agents";
import {
  finishAgentBoardTaskExecution,
  type AgentBoardRepository,
  type AgentBoardTaskRepository,
  type OrganizationRepository,
} from "@originpost/domain";

export interface BoardTaskExecutionJob {
  workspaceId: string;
  brandId: string;
  boardId: string;
  taskId: string;
  executionId: string;
  taskVersion: number;
  configurationEpoch: number;
  capabilityEpoch: number;
}

type Dependencies = {
  boards: AgentBoardRepository;
  tasks: AgentBoardTaskRepository;
  organizations: Pick<OrganizationRepository, "getBrand">;
  runtime: BoardRuntimePort;
  secret: string | Buffer;
  leaseSeconds?: number;
};

export async function processBoardTaskExecution(job: BoardTaskExecutionJob, dependencies: Dependencies) {
  const claimId = `board-task-${randomUUID()}`;
  const claimed = await dependencies.tasks.claimExecution(job.workspaceId, job.brandId, job.boardId, job.taskId, job.executionId, claimId, dependencies.leaseSeconds ?? 240);
  if (!claimed) return { skipped: true, reason: "claim-unavailable" } as const;
  const startedAt = Date.now();

  const finish = async (outcome: "succeeded" | "failed" | "uncertain", detail: {
    model?: string;
    resultText?: string;
    inputTokens?: number;
    outputTokens?: number;
    errorCode?: string;
    errorSummary?: string;
  }) => {
    const completed = finishAgentBoardTaskExecution({
      task: claimed.task,
      execution: claimed.execution,
      outcome,
      latencyMs: Math.max(0, Date.now() - startedAt),
      ...detail,
    });
    const saved = await dependencies.tasks.finishExecution(completed.task, claimed.task.version, completed.execution, claimId, completed.event);
    return saved ? { skipped: false, outcome } as const : { skipped: true, reason: "execution-fence-lost" } as const;
  };

  let invoked = false;
  try {
    const board = await dependencies.boards.get(job.workspaceId, job.boardId);
    const brand = await dependencies.organizations.getBrand(job.workspaceId, job.brandId);
    const expected = claimed.execution;
    if (!board || board.brandId !== job.brandId || brand?.status !== "active") return finish("failed", { errorCode: "board_unavailable", errorSummary: "This Board or its brand is no longer available for execution." });
    if (
      board.status !== "ready" || board.pendingPluginDecision ||
      board.configurationEpoch !== job.configurationEpoch || board.configurationEpoch !== expected.configurationEpoch ||
      board.observedConfigurationEpoch !== board.configurationEpoch ||
      board.capabilityEpoch !== job.capabilityEpoch || board.capabilityEpoch !== expected.capabilityEpoch ||
      claimed.task.version !== job.taskVersion || expected.taskVersion !== job.taskVersion
    ) return finish("failed", { errorCode: "board_execution_stale", errorSummary: "The Board policy or task changed before Hermes started." });

    const derived = deriveBoardRuntimeSecrets(dependencies.secret, { workspaceId: board.workspaceId, brandId: board.brandId, boardId: board.id, capabilityEpoch: board.capabilityEpoch });
    invoked = true;
    const result = await dependencies.runtime.executeTask({
      workspaceId: board.workspaceId,
      brandId: board.brandId,
      boardId: board.id,
      profile: board.hermesProfile,
      kanbanBoardRef: board.hermesBoardRef,
      capabilityEpoch: board.capabilityEpoch,
      ...derived,
    }, {
      taskId: claimed.task.id,
      executionId: expected.id,
      title: claimed.task.title,
      description: claimed.task.description,
      purpose: board.purpose,
      configurationEpoch: board.configurationEpoch,
      capabilityEpoch: board.capabilityEpoch,
      enabledSkills: board.desiredSkills,
    });

    const latest = await dependencies.boards.get(job.workspaceId, job.boardId);
    if (!latest || latest.brandId !== board.brandId || latest.status !== "ready" || latest.pendingPluginDecision || latest.configurationEpoch !== board.configurationEpoch || latest.observedConfigurationEpoch !== board.configurationEpoch || latest.capabilityEpoch !== board.capabilityEpoch) {
      return finish("uncertain", { errorCode: "board_policy_changed", errorSummary: "Hermes returned after this Board's policy changed. The result was fenced from review." });
    }
    return finish("succeeded", {
      model: result.model,
      resultText: result.text,
      ...(result.usage?.inputTokens !== undefined ? { inputTokens: result.usage.inputTokens } : {}),
      ...(result.usage?.outputTokens !== undefined ? { outputTokens: result.usage.outputTokens } : {}),
    });
  } catch (error) {
    return finish(invoked ? "uncertain" : "failed", {
      errorCode: invoked ? "hermes_result_uncertain" : "hermes_not_started",
      errorSummary: invoked
        ? "Hermes did not return a confirmed receipt. Check the execution before retrying."
        : error instanceof Error ? error.message.slice(0, 2_000) : "Hermes could not be started.",
    });
  }
}
