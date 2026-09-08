import { ShieldCheck } from "lucide-react";

export function InstagramStoryInternalCopyNote({ id }: { id?: string }) {
  return <small {...(id ? { id } : {})}><ShieldCheck size={13} /> Internal only — this text is saved for review and manual handoff. It is not sent as an Instagram Story caption.</small>;
}

export function InstagramStoryDeliveryGuidance({ mode }: { mode: "manual_handoff" | "auto_publish" }) {
  return mode === "manual_handoff" ? <>
    <strong>Manual handoff · interactive Stories</strong>
    <small>Honest choice for link, music, poll, location, and mention stickers. OriginPost still reminds a person and records publish proof.</small>
  </> : <>
    <strong>Auto publish · basic Story only</strong>
    <small>Publishes the checked image or video only. No link, music, poll, location, mention, or other interactive stickers.</small>
  </>;
}
