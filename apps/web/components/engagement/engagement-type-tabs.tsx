import { MessageCircle, MessagesSquare } from "lucide-react";

export type EngagementInboxType = "comments" | "messages";

export function EngagementTypeTabs({ value, onChange }: { value: EngagementInboxType; onChange: (value: EngagementInboxType) => void }) {
  return <nav className="engagement-type-tabs" aria-label="Engagement inbox type">
    <button type="button" className={value === "comments" ? "active" : ""} onClick={() => onChange("comments")} aria-current={value === "comments" ? "page" : undefined}><MessageCircle size={15} /> Public comments</button>
    <button type="button" className={value === "messages" ? "active" : ""} onClick={() => onChange("messages")} aria-current={value === "messages" ? "page" : undefined}><MessagesSquare size={15} /> Private messages</button>
  </nav>;
}
