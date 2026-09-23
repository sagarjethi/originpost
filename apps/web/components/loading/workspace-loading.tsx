"use client";

import { useEffect, useState } from 'react';
import styles from './workspace-loading.module.css';

type WorkspaceLoadingProps = { fullPage?: boolean; title?: string; description?: string; unavailable?: boolean };

export function WorkspaceLoading({ fullPage = true, title = 'Opening your workspace', description = 'Connecting to OriginPost…', unavailable = false }: WorkspaceLoadingProps) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!fullPage || unavailable) return;
    const timer = setTimeout(() => setSlow(true), 8_000);
    return () => clearTimeout(timer);
  }, [fullPage, unavailable]);

  if (!fullPage) return <section className={styles.inline} aria-label={title} aria-busy="true"><div role="status"><span className={styles.indicator} aria-hidden="true"/><strong>{title}</strong><p>{description}</p></div><div className={styles.skeleton} aria-hidden="true"><div/><div/><div/></div></section>;

  return <main className={styles.page}>
    <section className={styles.surface} aria-label={unavailable ? 'Connection unavailable' : 'Loading OriginPost'} aria-busy={!unavailable}>
      <div className={styles.identity}><span className={styles.mark} aria-hidden="true">O</span><span>OriginPost</span></div>
      <div role="status" aria-live="polite">
        <h1 className={styles.title}>{unavailable ? 'Cannot reach your workspace' : title}</h1>
        <p className={styles.description}>{unavailable ? 'OriginPost could not connect to its server. Your saved content has not been changed.' : description}</p>
      </div>
      {!unavailable && <div className={styles.track} aria-hidden="true"><span/></div>}
      {(slow || unavailable) && <div className={styles.recovery}>
        <p>{unavailable ? 'Check your connection. If this is a local installation, make sure OriginPost is running.' : 'The server is taking longer than usual. You can wait or try again.'}</p>
        <button type="button" onClick={() => window.location.reload()}>Try again</button>
      </div>}
    </section>
  </main>;
}
