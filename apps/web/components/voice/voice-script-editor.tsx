"use client";

import { useId } from 'react';
import { spokenScript } from '@originpost/domain';
import styles from './voice-script-editor.module.css';

/** The same editable narration and limit feedback in chat and the audio studio. */
export function VoiceScriptEditor({value,onChange,limit=3000,language,rows=5}:{value:string;onChange:(value:string)=>void;limit?:number;language?:string;rows?:number}) {
  const id=useId();
  const length=spokenScript(value).length;
  const remaining=limit-length;
  return <div className={styles.editor}>
    <div className={styles.heading}><label htmlFor={id}>Voice script</label><span className={remaining<0?styles.over:undefined}>{length.toLocaleString()} / {limit.toLocaleString()} characters</span></div>
    <textarea id={id} value={value} onChange={event=>onChange(event.target.value)} onBlur={()=>onChange(spokenScript(value))} rows={rows} maxLength={3000} lang={language} aria-describedby={`${id}-hint`} aria-invalid={remaining<0} placeholder={language==='gu'?'તમારા ચકાસેલા સમાચાર અહીં લખો…':language==='hi'?'अपनी जांची हुई खबर यहां लिखें…':'Write the words you want the voice to read…'}/>
    <p id={`${id}-hint`} className={remaining<0?styles.over:styles.hint}>{remaining<0?`Shorten by ${(-remaining).toLocaleString()} characters before generating. Your text has been kept intact.`:'Links and hashtag footers are removed. Review names and numbers before generating.'}</p>
  </div>;
}
