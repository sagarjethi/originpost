export type HelpJourneyId = "publish" | "image" | "board" | "channels";

export type HelpJourney = {
  id: HelpJourneyId;
  eyebrow: string;
  title: string;
  summary: string;
  outcome: string;
  capability: "available" | "runtime" | "planned";
  action: { label: string; destination: string };
  steps: Array<{ label: string; detail: string }>;
};

export const HELP_JOURNEYS: HelpJourney[] = [
  {
    id: "publish",
    eyebrow: "SOURCE TO PROOF",
    title: "Publish a verified post",
    summary: "Keep the source, editorial decision, approved draft, delivery result, and proof connected.",
    outcome: "A published item with its evidence and real platform proof attached.",
    capability: "available",
    action: { label: "Open Content", destination: "Content" },
    steps: [
      { label: "Capture", detail: "Add a link, note, or monitored signal to the Inbox." },
      { label: "Verify", detail: "Research current primary sources and connect them to the claims." },
      { label: "Create", detail: "Write the platform draft and attach approved media." },
      { label: "Approve", detail: "Review the exact revision before scheduling or handoff." },
      { label: "Publish", detail: "Use a connected channel or complete the safe manual handoff." },
      { label: "Prove", detail: "Save the live URL, platform ID, and observed result." },
    ],
  },
  {
    id: "image",
    eyebrow: "CHATGPT IMAGE CREATION",
    title: "Create a publish-safe image",
    summary: "Use ChatGPT image creation for the visual layer, then finish exact brand and editorial details in OriginPost.",
    outcome: "A checked visual in the Library, attached to the exact draft that was approved.",
    capability: "runtime",
    action: { label: "Open Creative Studio", destination: "Creative Studio" },
    steps: [
      { label: "Brief", detail: "Start from the verified story, format, audience, and visual intent." },
      { label: "Generate", detail: "Create the image with ChatGPT using a complete, structured prompt." },
      { label: "Finish", detail: "Add exact text, logos, credits, and safe-area layout deterministically." },
      { label: "Check", detail: "Inspect spelling, numbers, brand use, provenance, and visual integrity." },
      { label: "Disclose", detail: "Mark generated or materially AI-edited visuals when disclosure is required." },
      { label: "Attach", detail: "Save to the Library and attach it to the draft before approval." },
    ],
  },
  {
    id: "board",
    eyebrow: "BOARD TO REVIEW",
    title: "Run focused work on a Board",
    summary: "A Board owns its tasks, memory, and approved skills. Hermes is an internal helper, not a separate workspace.",
    outcome: "Board-scoped work reaches human review without crossing another Board's context.",
    capability: "available",
    action: { label: "Open Boards", destination: "Boards" },
    steps: [
      { label: "Create task", detail: "Capture the outcome and dependencies in the Board's Tasks view." },
      { label: "Triage", detail: "A person clarifies scope, chooses Team or Board agent, and resolves dependencies." },
      { label: "Release", detail: "A manager or owner explicitly releases a ready Board-agent task to Hermes." },
      { label: "Work", detail: "Hermes runs with this Board’s approved memory and skills while status refreshes in Tasks." },
      { label: "Review", detail: "A manager or owner reviews the result separately before approving completion." },
      { label: "Continue", detail: "Turn approved research or copy into an OriginPost content item." },
    ],
  },
  {
    id: "channels",
    eyebrow: "CHANNEL TO RESULT",
    title: "Connect and publish safely",
    summary: "Separate account setup from editorial work, then verify every provider result before claiming success.",
    outcome: "A healthy channel connection and proof-backed delivery history.",
    capability: "available",
    action: { label: "Manage channels", destination: "Channels" },
    steps: [
      { label: "Connect", detail: "Authorize the official provider account and select the intended destination." },
      { label: "Check", detail: "Confirm permissions, token health, and supported publishing capabilities." },
      { label: "Schedule", detail: "Choose the approved draft, account, date, time, and delivery mode." },
      { label: "Observe", detail: "If the provider result is uncertain, stop and check before retrying." },
      { label: "Prove", detail: "Store the real post URL and external ID after successful delivery." },
    ],
  },
];

export function getHelpJourney(id: HelpJourneyId): HelpJourney {
  return HELP_JOURNEYS.find((journey) => journey.id === id) ?? HELP_JOURNEYS[0]!;
}
