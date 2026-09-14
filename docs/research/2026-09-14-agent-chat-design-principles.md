# Agent chat design principles for OriginPost

Researched 2026-09-14. This is a source-grounded design brief, not a claim that any named designer reviewed or endorsed OriginPost. The six implementation principles below are our synthesis. Existing OriginPost scope, approval and publication contracts remain authoritative.

## Verified people and attribution

| Person | First-party evidence and relevant idea | Attribution limit |
| --- | --- | --- |
| Blaine Billingsley, OpenAI designer | In his published first-person interview, he identifies himself as an OpenAI designer and describes working on the ChatGPT product-design plugin. He emphasizes deciding what useful output looks like, evaluating repeated results, exploring multiple directions and preserving team feedback. [Original interview and transcript, Aug 12, 2026](https://www.buzzsprout.com/1797429/episodes/19635662-inside-the-product-design-process-at-openai-blaine-billingsley-openai) | These are his stated methods, not an official universal ChatGPT UI specification. The source is the original interview publisher, not OpenAI's website. |
| Peter Vidani, OpenAI designer | His own announcement identifies his appointment as Designer at OpenAI. [Personal announcement](https://www.linkedin.com/posts/vidani_im-happy-to-share-that-im-starting-a-new-activity-7156398176470491136-YYtD) | This verifies an appointment; it does not establish sole authorship of ChatGPT, current ownership of a specific screen, or a personal design doctrine. |
| Nate Parrott, Anthropic product designer | His Anthropic-published first-person article identifies his work on Claude Code for VS Code and the prototype that became Claude Design. He describes a chat/output split view, incorporating real brand assets and principles, interactive HTML prototypes, and continued conversation during work. [Article, Jul 24, 2026](https://claude.com/blog/how-the-product-designer-who-built-claude-design-uses-it-to-explore-ideas-before-building-them) | The page expressly identifies these as his opinions and usage advice; Claude Design and Claude's general chat are different surfaces. |
| Joel Lewenstein, Anthropic design leader | His own site says he leads Anthropic's design team. His own hiring post describes balancing immediate usefulness and enjoyment with exploration of new interfaces, supported by design engineering. [Personal site](https://www.joellewenstein.com/), [personal design-team post](https://www.linkedin.com/posts/joel-lewenstein_product-designer-activity-7233873362626691072-QNpV/) | Do not attribute every Claude interaction or visual detail to one leader. |

OpenAI separately publishes institutional UI guidance about lightweight conversational cards, progressive expansion and coherent typography/spacing. Those recommendations should be attributed to **OpenAI's documentation**, not invented as quotations from one designer. [Official UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines).

## What “Super UI” might mean

**SuperUI.tech** describes a catalog of reusable UI prompts for coding assistants. Its indexed first-party homepage presents copy/paste prompts and examples of visual systems; it is not evidence of a chat SDK. Direct page fetches failed during this research, so the verified description is limited to the returned first-party search text. Its claim of production-ready output is marketing, not validation. [SuperUI.tech](https://www.superui.tech/).

**Superinterface** is a different product. Its own site describes embedded AI interfaces and interactive chat elements; its creation guide offers a single assistant or a group of assistants and configurable interface presentation. This is a closer interaction reference for an in-product agent chat. [Superinterface](https://superinterface.ai/), [interface creation guide](https://superinterface.ai/docs/interfaces/create).

The user's intended “Super UI” identity remains unconfirmed. These names must not be merged, attributed to OpenAI/Anthropic, or presented as OriginPost dependencies without a separate decision. Neither source establishes which individual designed the interface.

## Six actionable implementation principles

### 1. Make the conversation the stable center

Use one dominant transcript and one composer, with a compact conversation rail. Open detailed output beside the chat only when selected; retain context when closing it. On mobile, move details into a sheet. This adapts Parrott's chat/output prototype to OriginPost's existing `/agent` architecture. **Acceptance:** opening an image or draft does not lose the active conversation, entered text or selected scope. [Parrott's first-person account](https://claude.com/blog/how-the-product-designer-who-built-claude-design-uses-it-to-explore-ideas-before-building-them).

### 2. Give every card one clear job

Use compact inline cards for a draft, research result or decision. Keep one main action and at most one secondary action; expand rich work into an inspector. Avoid card tabs, nested scrolling and duplicate composers. **Acceptance:** a user can tell what a card contains and what its main button does without opening it. This is adapted from OpenAI's inline-card guidance. [Official UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines).

### 3. Use OriginPost's visual system consistently

Reuse existing type, spacing, surfaces, controls and focus behavior. Use accent color selectively for actions and meaningful states; rely on alignment and whitespace for hierarchy. **Acceptance:** the agent surface looks like part of OriginPost at desktop and phone sizes, with readable content and no distorted image previews. OpenAI's guidance supports consistent foundations; importing its exact branding is unnecessary. [Official UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines).

### 4. Design the deliverable as carefully as the input box

An image task should yield an inspectable image-and-copy package with source links and revision identity. Give users direct actions to inspect or revise the relevant artifact. **Acceptance:** the UI can show the result, its accompanying text and its current state without requiring the user to reconstruct it from progress messages. Billingsley's emphasis on output criteria and repeated evaluation informs this product-specific recommendation. [Original interview](https://www.buzzsprout.com/1797429/episodes/19635662-inside-the-product-design-process-at-openai-blaine-billingsley-openai).

### 5. Make collaboration visible without making users operate a machine

Provide a discoverable mention picker with plain role descriptions. Show the current owner and concise activity when specialists hand off work; keep tool diagnostics collapsed. User follow-ups remain part of the same conversation. **Acceptance:** users can identify who is working, inspect the result and interrupt work without learning runtime/provider terminology. This combines Grok's documented mentions/handoffs with OriginPost's scoped-specialist model. [Grok messaging documentation](https://docs.x.ai/grok-bot/chat-and-collaboration).

### 6. Evaluate real states, including when work goes wrong

Review empty, loading, streaming, interrupted, failed, waiting-for-decision and uncertain-publication states alongside the successful flow. Use representative long copy, images and source lists, not only polished sample text. **Acceptance:** keyboard users can reach controls; narrow screens keep the composer usable; failures preserve the draft and explain the next available action. Publication success appears only with its authoritative receipt. Billingsley's evaluation approach informs this test discipline; the publication constraints come from OriginPost's master agent plan. [Original interview](https://www.buzzsprout.com/1797429/episodes/19635662-inside-the-product-design-process-at-openai-blaine-billingsley-openai), [local plan](../master-agent-chat.md).

## Remaining uncertainties

- This research does not identify a sole designer of ChatGPT or Claude; both are team products. Verified associations must not become invented authorship claims.
- The sources do not prove that a particular background tint, radius or sidebar width increases usability. Such choices need OriginPost-specific visual and interaction checks.
- Product documentation describes behavior available at retrieval; it is not evidence that OriginPost's provider adapters or backend already support those features.
- Original interview transcripts may contain transcription errors. This note paraphrases limited, clearly supported ideas and avoids relying on uncertain spellings or exact wording.
- This brief is not a license to bypass existing human review, widen Brand/Board scope, or replace the current component system with an unrelated prompt-generated theme.
