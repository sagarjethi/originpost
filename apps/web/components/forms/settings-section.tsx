import type { ReactNode } from "react";
import styles from "./settings-section.module.css";

/** A visible group for required settings; browser validation can always reach its fields. */
export function SettingsSection({ title, description, children }: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return <fieldset className={styles.section}>
    <legend>{title}</legend>
    {description && <p className={styles.description}>{description}</p>}
    <div className={styles.fields}>{children}</div>
  </fieldset>;
}
