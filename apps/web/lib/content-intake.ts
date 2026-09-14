import { apiFetch } from "./api-client";

/** Keep the saved item when the optional research command fails. */
export async function saveContentIntake<T extends { id: string; version?: number }>(
  input: { workspaceId: string; brandId: string; title: string; summary: string; researchNow: boolean; csrfToken?: string },
  request = apiFetch,
): Promise<{ item: T; warning?: string }> {
  let response: Response;
  try {
    response = await request("/v1/content-items", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: input.workspaceId, brandId: input.brandId, title: input.title, summary: input.summary, researchDepth: "standard", riskLevel: "low" }),
    }, input.csrfToken);
  } catch {
    throw new Error("The save could not be confirmed. Check Content before trying again. Your input is still here.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Content could not be saved. Your input is still here.");
  }
  const item = await response.json() as T;
  if (!input.researchNow) return { item };
  try {
    const research = await request(`/v1/content-items/${encodeURIComponent(item.id)}/research?workspaceId=${encodeURIComponent(input.workspaceId)}`, {
      method: "POST", headers: { "content-type": "application/json", ...(item.version ? { "if-match": String(item.version) } : {}) },
      body: JSON.stringify({ query: input.title, depth: "standard", languages: ["English", "Gujarati", "Hindi"], region: "India", sourceLimit: 8, freshnessHours: 168 }),
    }, input.csrfToken);
    if (!research.ok) throw new Error("Research did not start");
    return { item: await research.json() as T };
  } catch {
    return { item, warning: "Your content is saved, but research could not be confirmed. Check its research status before running it again." };
  }
}
