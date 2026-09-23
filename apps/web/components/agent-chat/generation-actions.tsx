import styles from './generation-actions.module.css';

export function GenerationActions({ text, image, review, research, loading, unavailable = false, canConfigure }: { research?: boolean | undefined; text?: boolean | undefined; image?: boolean | undefined; review?: boolean | undefined; loading: boolean; unavailable?: boolean; canConfigure: boolean }) {
  const status = (ready?: boolean) => unavailable ? 'Status unavailable' : loading || ready === undefined ? 'Checking…' : ready ? 'Configured' : 'Setup needed';
  return <section className={styles.panel} aria-label="Text and image generation">
    <div><strong>Text + image</strong><p>With research and providers configured, one request writes the headline and caption, then creates the image after copy review.</p></div>
    <div className={styles.actions}>
      <span>Research <small>{status(research)}</small></span>
      <span>Text <small>{status(text)}</small></span>
      <span>Image <small>{status(image)}</small></span>
      <span>Image review <small>{status(review)}</small></span>
      <a href="/create">Generate text</a>
      <a href="/creative-studio?generate=image">Generate an image</a>
    </div>
    {!loading && !unavailable && canConfigure && (text === false || review === false || image === false) && <div className={styles.actions}>
      {(text === false || review === false) && <a href="/agent-plugins">Set up text and vision models</a>}
      {image === false && <a href="/setup?provider=images">Set up image generation</a>}
    </div>}
    {!loading && !unavailable && !canConfigure && (text === false || image === false || review === false) && <p>Ask your workspace owner to configure the missing services.</p>}
    {unavailable && <p role="status">Cannot check the workflow API. Connection checks will refresh automatically.</p>}
  {!loading && !unavailable && research === false && <p>Full news creation needs live research through Hermes or the local Codex bridge. Your server operator must enable that service. Text and image tools can be used separately.</p>}
  </section>;
}
