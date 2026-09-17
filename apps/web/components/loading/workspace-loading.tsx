"use client";

import { useEffect, useState } from 'react';
import styles from './workspace-loading.module.css';

export function WorkspaceLoading({fullPage=true,title='Opening your workspace',description='Your stories, projects and tools will be here in a moment.'}:{fullPage?:boolean;title?:string;description?:string}) {
  const [slow,setSlow]=useState(false);
  useEffect(()=>{if(!fullPage)return;const timer=setTimeout(()=>setSlow(true),12000);return ()=>clearTimeout(timer);},[fullPage]);
  const content=<>
    <div className={styles.identity}><div className="brand-mark" aria-hidden="true"><span>O</span></div><span>OriginPost</span><span className={styles.edition}>YOUR EDITORIAL WORKSPACE</span></div>
    <div className={styles.canvas} aria-hidden="true">
      <div className={styles.orbit}/>
      <div className={styles.note}><span className={styles.dot}/><i/><i/><i/></div>
      <div className={styles.story}><div className={styles.art}><span/><span/><span/></div><i/><i/><div className={styles.storyFooter}><span/><span/></div></div>
      <div className={styles.voice}>{[1,2,3,4,5,6,7].map(n=><span key={n}/>)}</div>
    </div>
    <div className={styles.copy} role="status" aria-live="polite"><p className={styles.kicker}>A LITTLE SPACE FOR YOUR NEXT BIG STORY</p><h1 className={styles.title}>{title}<span className={styles.dots} aria-hidden="true">…</span></h1><p>{description}</p></div>
    <div className={styles.track} aria-hidden="true"><span/></div>
    {slow&&<div className={styles.recovery}><p>This is taking longer than usual. Check your connection or try loading again.</p><button type="button" onClick={()=>window.location.reload()}>Reload workspace</button></div>}
  </>;
  if(fullPage)return <main className={styles.page}><section className={styles.surface} aria-label="Loading OriginPost">{content}</section><p className={styles.signature}>From a trusted source to a story worth sharing.</p></main>;
  return <section className={styles.inline} aria-label={title}><div role="status"><span className={styles.indicator} aria-hidden="true"/><strong>{title}</strong><p>{description}</p></div><div className={styles.skeleton} aria-hidden="true"><div><i/><i/><span/><i/></div><div><i/><i/><i/></div></div></section>;
}
