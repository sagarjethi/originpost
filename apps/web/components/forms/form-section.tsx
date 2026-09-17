import type { ReactNode } from 'react';
import styles from './form-section.module.css';
/** Shared progressive disclosure for configuration forms. Children stay mounted so defaults are submitted. */
export function FormSection({title,description,children,open=false}:{title:string;description?:string;children:ReactNode;open?:boolean}) {
  return <details className={styles.section} open={open}><summary>{title}</summary>{description&&<p>{description}</p>}<div className={styles.body}>{children}</div></details>;
}
