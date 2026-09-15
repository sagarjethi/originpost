import { FileText, ShieldCheck } from "lucide-react";
export type SourceEvidenceView = {
  id: string;
  title: string;
  url?: string;
  publisher?: string;
  publishedAt?: string;
  confidence: number;
  excerpt?: string;
  retrieval?: {
    status: "matched" | "mismatch" | "unavailable";
    checkedAt: string;
    finalUrl?: string;
    sha256?: string;
    reason?: string;
  };
};
function publicLink(value?: string) {
  try {
    const url = new URL(value ?? "");
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function SourceEvidenceCard({ source }: { source: SourceEvidenceView }) {
  const url = publicLink(source.url),
    proof = source.retrieval;
  return (
    <div className="source-card">
      <FileText size={17} />
      <div>
        <strong>
          {url ? (
            <a href={url} target="_blank" rel="noreferrer">
              {source.title}
            </a>
          ) : (
            source.title
          )}
        </strong>
        <small>{source.publisher ?? "Saved source"} · Reference only</small>
        {proof ? (
          <details className="source-retrieval">
            <summary>
              {proof.status === "matched"
                ? "Excerpt found on retrieved page"
                : proof.status === "mismatch"
                  ? "Excerpt did not match"
                  : "Page check unavailable"}
            </summary>
            <p>
              Checked {proof.checkedAt}. This checks the quoted text, not every
              claim or image rights.
            </p>
            {source.excerpt && <blockquote>{source.excerpt}</blockquote>}
            {proof.reason && <p>{proof.reason}</p>}
            {proof.sha256 && (
              <p>
                Retrieved response SHA-256: <code>{proof.sha256}</code>
              </p>
            )}
          </details>
        ) : (
          <small>No independent page check recorded.</small>
        )}
      </div>
      {proof?.status === "matched" ? (
        <ShieldCheck size={16} aria-label="Excerpt match recorded" />
      ) : (
        <span />
      )}
    </div>
  );
}
