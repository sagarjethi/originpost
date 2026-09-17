import { Injectable, ServiceUnavailableException } from '@nestjs/common';
export interface AudioVoice { id: string; name: string; category: string }
export interface AudioModel { id: string; name: string; languages: { code: string; name: string }[]; maxCharacters: number }
export interface AudioProvider {
  readonly id: string;
  models(key: string): Promise<AudioModel[]>;
  voices(key: string, cursor?: string): Promise<{ voices: AudioVoice[]; nextCursor?: string }>;
  synthesize(key: string, input: { text: string; voiceId: string; model: string; language: string }): Promise<Uint8Array>;
}
async function bytes(response: Response, limit: number) {
  if (!response.ok) { await response.body?.cancel(); throw new ServiceUnavailableException(response.status === 401 || response.status === 403 ? 'Provider access denied. Ask the owner to check the API key and its permissions.' : response.status === 429 ? 'Provider quota or rate limit reached.' : 'Audio provider failed. No other provider was used.'); }
  if (!response.body || Number(response.headers.get('content-length') ?? 0) > limit) { await response.body?.cancel(); throw new ServiceUnavailableException('Provider response exceeds the size limit.'); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) throw new ServiceUnavailableException('Provider response exceeds the size limit.'); chunks.push(value); } }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(chunks);
}
@Injectable()
export class ElevenLabsAudioProvider implements AudioProvider {
  readonly id = 'elevenlabs';
  private async request(key: string, path: string, body?: unknown) {
    try { return await fetch(`https://api.elevenlabs.io${path}`, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(body ? 90_000 : 15_000), headers: { 'xi-api-key': key, ...(body ? { 'content-type': 'application/json', accept: 'audio/mpeg' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new ServiceUnavailableException('Audio provider timed out or could not be reached. A generation may have been charged; automatic retries are disabled.'); }
  }
  async models(key: string) {
    const data = JSON.parse((await bytes(await this.request(key, '/v1/models'), 2_000_000)).toString()) as Array<{ model_id: string; name: string; can_do_text_to_speech: boolean; languages: { language_id: string; name: string }[]; maximum_text_length_per_request?: number }>;
    if (!Array.isArray(data)) throw new ServiceUnavailableException('Invalid model catalogue.');
    return data.filter(x => x.can_do_text_to_speech && typeof x.model_id === 'string').map(x => ({ id: x.model_id, name: x.name, languages: (x.languages ?? []).map(l => ({ code: l.language_id, name: l.name })), maxCharacters: x.maximum_text_length_per_request ?? 3000 }));
  }
  async voices(key: string, cursor?: string) {
    const query = new URLSearchParams({ page_size: '100', ...(cursor ? { next_page_token: cursor } : {}) });
    const data = JSON.parse((await bytes(await this.request(key, `/v2/voices?${query}`), 2_000_000)).toString()) as { voices: { voice_id: string; name: string; category: string }[]; has_more?: boolean; next_page_token?: string };
    if (!Array.isArray(data.voices)) throw new ServiceUnavailableException('Invalid voice catalogue.');
    return { voices: data.voices.map(v => ({ id: v.voice_id, name: v.name, category: v.category })), ...(data.has_more && data.next_page_token ? { nextCursor: data.next_page_token } : {}) };
  }
  async synthesize(key: string, input: { text: string; voiceId: string; model: string; language: string }) {
    const response = await this.request(key, `/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=mp3_44100_128`, { text: input.text, model_id: input.model, ...(input.model === 'eleven_multilingual_v2' ? {} : { language_code: input.language }) });
    const audio = await bytes(response, 20 * 1024 * 1024);
    if (!response.headers.get('content-type')?.startsWith('audio/') || !(audio.subarray(0,3).toString() === 'ID3' || (audio[0] === 0xff && ((audio[1] ?? 0) & 0xe0) === 0xe0))) throw new ServiceUnavailableException('Provider did not return valid MP3 audio.');
    return audio;
  }
}
@Injectable()
export class AudioProviders {
  constructor(private readonly elevenLabs: ElevenLabsAudioProvider) {}
  get(id: string): AudioProvider { if (id === this.elevenLabs.id) return this.elevenLabs; throw new ServiceUnavailableException('This audio provider does not have an installed adapter.'); }
}
