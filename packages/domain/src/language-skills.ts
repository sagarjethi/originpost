import { z } from 'zod';
import type { AudioSkill } from './audio.js';

export const languageSkills: AudioSkill[] = [
  { id:'gujarati-news',version:'1.0.0',name:'ગુજરાતી સમાચાર',language:'gu',maxCharacters:1500,instructions:'સરળ, રોજબરોજની ગુજરાતીમાં લખો. એક વાક્યમાં એક વાત રાખો. નામ, સ્થળ, તારીખ અને આંકડા મૂળ સ્રોત પ્રમાણે જ રાખો. આરોપને હકીકત તરીકે ન કહો. અવાજ બનાવતાં પહેલાં લખાણ વાંચીને તપાસો.' },
  { id:'hindi-news',version:'1.0.0',name:'हिंदी समाचार',language:'hi',maxCharacters:1500,instructions:'सरल हिंदी और छोटे वाक्य लिखें। नाम, जगह, तारीख और आंकड़े स्रोत के अनुसार रखें। आरोप को तथ्य न बताएं। आवाज़ बनाने से पहले पूरी स्क्रिप्ट पढ़कर जांचें।' },
  { id:'english-news',version:'1.0.0',name:'English news',language:'en',maxCharacters:1500,instructions:'Use plain English and short sentences. Preserve source names, places, dates and numbers. Attribute allegations. Review every sentence before generating narration. Do not invent facts or dialogue.' },
  { id:'gujarati-weather',version:'1.0.0',name:'ગુજરાતી હવામાન',language:'gu',maxCharacters:1200,instructions:'શાંત અને સ્પષ્ટ રીતે હવામાનની માહિતી આપો. સ્થળ, આગાહીનો સમય, તાપમાન અને વરસાદની શક્યતા સ્રોત પ્રમાણે રાખો. આગાહીને ખાતરી તરીકે ન કહો. ચેતવણી હોય તો તેને સ્રોતના નામ સાથે કહો.' },
  { id:'hindi-weather',version:'1.0.0',name:'हिंदी मौसम',language:'hi',maxCharacters:1200,instructions:'शांत और स्पष्ट भाषा में मौसम बताएं। जगह, पूर्वानुमान का समय, तापमान और बारिश की संभावना स्रोत के अनुसार रखें। पूर्वानुमान को पक्का न बताएं। चेतावनी हो तो स्रोत का नाम दें।' },
  { id:'english-weather',version:'1.0.0',name:'English weather reader',language:'en',maxCharacters:1200,instructions:'Use a calm, clear weather-reader style. State the location and forecast period first. Preserve temperatures, units and rain probabilities. Attribute warnings and keep forecasts uncertain. Do not add dramatic claims.' },
  { id:'gujarati-explainer',version:'1.0.0',name:'ગુજરાતીમાં સરળ સમજ',language:'gu',maxCharacters:1800,instructions:'વાતચીત જેવી સરળ ભાષામાં સમજાવો. શું થયું, કોને અસર થશે અને આગળ શું થઈ શકે તે અલગ વાક્યોમાં કહો. સ્રોતમાં ન હોય તેવું ઉદાહરણ કે આંકડો ઉમેરશો નહીં. નામ અને આંકડા બોલવામાં સરળ છે કે નહીં તે તપાસો.' },
  { id:'hindi-explainer',version:'1.0.0',name:'हिंदी में आसान समझ',language:'hi',maxCharacters:1800,instructions:'बातचीत जैसी सरल भाषा रखें। क्या हुआ, किस पर असर होगा और आगे क्या हो सकता है, अलग वाक्यों में समझाएं। स्रोत में न दिए गए उदाहरण या आंकड़े न जोड़ें। नाम और आंकड़ों का उच्चारण जांचें।' },
  { id:'english-explainer',version:'1.0.0',name:'English conversational explainer',language:'en',maxCharacters:1800,instructions:'Use a warm, conversational tone. Explain what happened, who is affected and what is still uncertain in separate short sentences. Preserve locked facts. Do not invent examples or quotations. Check pronunciation before publication.' },
];
export const languageSkillSchema = z.object({
  id:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), version:z.string().regex(/^\d+\.\d+\.\d+$/),
  name:z.string().trim().min(1).max(100), language:z.string().regex(/^[a-z]{2,3}$/),
  instructions:z.string().trim().min(1).max(2000), maxCharacters:z.number().int().min(1).max(3000),
}).strict();
export function languageCode(value:string) {
  const normalized=value.trim().toLowerCase();
  return ({gujarati:'gu','ગુજરાતી':'gu',hindi:'hi','हिंदी':'hi',english:'en'} as Record<string,string>)[normalized] ?? normalized;
}
export function selectedLanguageSkills(locale:string,skills:AudioSkill[] = []) {
  const code=languageCode(locale);
  return skills.filter(skill=>skill.language===code).slice(0,3);
}
export const shortAudioSamples:Record<string,string>={
  gu:'નમસ્તે! આ ગુજરાતી અવાજનું નાનું પરીક્ષણ છે. શબ્દો સ્પષ્ટ સંભળાય છે?',
  hi:'नमस्ते! यह हिंदी आवाज़ का छोटा परीक्षण है। क्या शब्द साफ़ सुनाई दे रहे हैं?',
};
