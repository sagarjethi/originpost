import { FileCheck2, Radar, WandSparkles } from "lucide-react";
import styles from "./source-generation-guide.module.css";

export function SourceGenerationGuide({ brandName, canConfigure }: { brandName: string; canConfigure: boolean }) {
  return <section className={styles.guide} aria-label="From news update to published post">
    <div className={styles.heading}><strong>From update to post</strong><span>{brandName || "Selected brand"}</span></div>
    <ol className={styles.steps}>
      <li><Radar size={17} /><div><strong>Choose an update</strong><p>Scheduled sources bring new reports here, with their original links.</p></div></li>
      <li><WandSparkles size={17} /><div><strong>Generate text & image</strong><p>Open a report in Agent. Choose a project for its template, logo and writing style.</p></div></li>
      <li><FileCheck2 size={17} /><div><strong>Review, then publish</strong><p>Check the draft and sources. An authorized publisher approves the post and selects its social account.</p></div></li>
    </ol>
    <details className={styles.help}>
      <summary>Instagram automation & generation setup</summary>
      <p>Connecting Instagram enables publishing to your account. It does not monitor other Instagram profiles. For automatic discovery, add an RSS/Atom feed or supported public publisher page below.</p>
      <p>Agent checks research, text, image and review services before starting. You can use an image API or the Codex image upload workflow. Opening a report does not start generation or publish it.</p>
      <div className={styles.links}><a href="/channels">Social accounts</a>{canConfigure ? <><a href="/agent-plugins">Text & vision providers</a><a href="/setup?provider=images">Image generation setup</a></> : <span>Your workspace owner manages provider connections.</span>}</div>
    </details>
  </section>;
}
