import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VoiceScriptEditor } from './voice-script-editor';

describe('voice script limits', () => {
  it('keeps a long draft and reports the excess without silently cutting it', () => {
    const text='a'.repeat(125);
    const html=renderToStaticMarkup(<VoiceScriptEditor value={text} onChange={()=>{}} limit={100}/>);
    expect(html).toContain(text);
    expect(html).toContain('125 / 100 characters');
    expect(html).toContain('Shorten by 25 characters');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby=');
  });
  it('counts only the narration the backend will synthesize', () => {
    const html=renderToStaticMarkup(<VoiceScriptEditor value={'News.\nhttps://example.org\n#News'} onChange={()=>{}} limit={100}/>);
    expect(html).toContain('5 / 100 characters');
    expect(html).toContain('aria-invalid="false"');
  });
});
