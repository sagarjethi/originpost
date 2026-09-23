"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, FileText, Image, Mic, Plus, Sparkles } from "lucide-react";
import styles from "./generation-launcher.module.css";
import { workspaceHref } from "../../lib/workspace-route";

type Props = {
  brandName: string;
  canConfigure: boolean;
  content?: { id: string; title: string } | undefined;
};

export function GenerationChoices({ brandName, canConfigure, content }: Props) {
  return <>
    <div className={styles.heading}><strong>Create for {brandName || "this brand"}</strong><span>Choose a tool. Generation starts after you submit a brief.</span></div>
    {content && <p className={styles.context} title={content.title}>Selected post: {content.title}</p>}
    <div className={styles.choices}>
      <a href="/agent"><Sparkles size={18} /><span><strong>Text + image</strong><small>Research a story and create a reviewed draft</small></span></a>
      <a href={content ? workspaceHref("Create", { itemId: content.id }) : "/create?compose=new"}><FileText size={18} /><span><strong>Generate text</strong><small>{content ? "Write a caption for the selected post" : "Start a brief, then generate the caption"}</small></span></a>
      <a href={workspaceHref("Creative Studio", { itemId: content?.id ?? "" })}><Image size={18} /><span><strong>Generate an image</strong><small>{content ? "Create a visual for the selected post" : "Create a visual from a prompt or reference"}</small></span></a>
      <a href="/audio"><Mic size={18} /><span><strong>Generate voice</strong><small>Turn a script into audio</small></span></a>
      <a href="/create?compose=new"><Plus size={18} /><span><strong>Add content manually</strong><small>Save your own notes or news brief</small></span></a>
    </div>
    <div className={styles.footer}><a href="/signals">Browse source updates</a>{canConfigure && <a href="/agent-plugins">AI providers</a>}</div>
  </>;
}

export function GenerationLauncher(props: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div ref={root} className={styles.root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className="new-button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><Plus size={17} /><span>Create</span><ChevronDown size={14} /></button>
    {open && <section id={id} className={styles.popover} aria-label="Create content"><GenerationChoices {...props} /></section>}
  </div>;
}
