import type { ReactNode } from "react";
import styles from "./workspace-page-header.module.css";

export function WorkspacePageHeader({ eyebrow, title, description, children }: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return <header className={styles.header}>
    <div className={styles.copy}><p className={styles.eyebrow}>{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>
    {children && <div className={styles.actions}>{children}</div>}
  </header>;
}
