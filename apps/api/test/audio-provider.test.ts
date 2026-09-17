import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsAudioProvider } from '../src/audio/audio-provider.js';
const key='provider-test-placeholder';
afterEach(()=>vi.unstubAllGlobals());
describe('ElevenLabs adapter',()=>{
  it('uses the explicit model and ISO language; keys only go to the fixed provider origin',async()=>{
    const fetcher=vi.fn(async()=>new Response(new Uint8Array([73,68,51,0,0,0]),{headers:{'content-type':'audio/mpeg'}}));vi.stubGlobal('fetch',fetcher);
    await new ElevenLabsAudioProvider().synthesize(key,{text:'નમસ્તે',voiceId:'voice',model:'eleven_v3',language:'gu'});
    const [url,options]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice?output_format=mp3_44100_128');expect(options.redirect).toBe('error');expect(options.headers).toMatchObject({'xi-api-key':key});expect(JSON.parse(String(options.body))).toEqual({text:'નમસ્તે',model_id:'eleven_v3',language_code:'gu'});
  });
  it('returns only safe voice fields and carries the pagination cursor',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({voices:[{voice_id:'v',name:'Voice',category:'premade',private_metadata:'omit'}],has_more:true,next_page_token:'next'}))));
    expect(await new ElevenLabsAudioProvider().voices(key)).toEqual({voices:[{id:'v',name:'Voice',category:'premade'}],nextCursor:'next'});
  });
  it('rejects oversized or non-audio responses and strips upstream error details',async()=>{
    const provider=new ElevenLabsAudioProvider(),input={text:'Hello',voiceId:'v',model:'eleven_v3',language:'en'};
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('private upstream message',{status:401})));
    await expect(provider.synthesize(key,input)).rejects.toThrow('Provider access denied');
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('html',{headers:{'content-type':'text/html'}})));
    await expect(provider.synthesize(key,input)).rejects.toThrow('MP3');
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('audio',{headers:{'content-length':String(25*1024*1024)}})));
    await expect(provider.synthesize(key,input)).rejects.toThrow('size limit');
  });
});
