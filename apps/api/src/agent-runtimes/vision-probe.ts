import { randomInt } from "node:crypto";
import sharp from "sharp";
import { AgentProviderError, type AgentProvider } from "@originpost/agents";

/** A small, non-private sample tests actual image input, not just a model listing. */
export async function probeImageInput(provider: AgentProvider) {
  const palette = ["red", "blue", "green", "yellow", "black", "white"];
  const colors: string[] = [];
  while (colors.length < 3) {
    const color = palette[randomInt(palette.length)]!;
    if (!colors.includes(color)) colors.push(color);
  }
  const svg = `<svg width="480" height="160" xmlns="http://www.w3.org/2000/svg">${colors.map((color, index) => `<rect x="${index * 160}" width="160" height="160" fill="${color}"/>`).join("")}</svg>`;
  const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
  const result = await provider.run({
    sessionKey: "originpost:vision-input-test",
    messages: [
      {
        role: "user",
        content:
          'Read the three solid color panels in the attached image, from left to right. Return only JSON: {"colors":["color","color","color"]}. Use lowercase basic color names.',
      },
    ],
    imageInputs: [
      {
        dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
        detail: "high",
      },
    ],
    maxTokens: 1000,
  });
  let observed: unknown;
  try {
    observed = JSON.parse(
      result.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""),
    ).colors;
  } catch {}
  if (
    !Array.isArray(observed) ||
    observed.length !== 3 ||
    observed.some((value, index) => value !== colors[index])
  )
    throw new AgentProviderError(
      "The selected vision model did not correctly read the sample image. Choose an image-capable model and test again.",
      "invalid_response",
    );
  return { model: result.model, imageInputTested: true };
}
