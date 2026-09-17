import {describe,it,expect} from 'vitest';
import {languageSkills,languageCode,selectedLanguageSkills,languageSkillSchema,shortAudioSamples} from '../src/language-skills.js';
describe('scoped project language skills',()=>{
 it('loads only the selected locale and bounds context to three skills',()=>{
   expect(languageCode('ગુજરાતી')).toBe('gu');expect(languageCode('Hindi')).toBe('hi');
   const selected=selectedLanguageSkills('Gujarati',languageSkills);
   expect(selected).toHaveLength(3);expect(selected.every(s=>s.language==='gu')).toBe(true);
   expect(selectedLanguageSkills('fr',languageSkills)).toEqual([]);
 });
 it('rejects executable fields and excessive guidance',()=>{
   expect(languageSkillSchema.safeParse({...languageSkills[0],tools:['shell']}).success).toBe(false);
   expect(languageSkillSchema.safeParse({...languageSkills[0],instructions:'a'.repeat(2001)}).success).toBe(false);
 });
 it('provides exactly two scripts within the requested 100-character ceiling',()=>{
   expect(Object.keys(shortAudioSamples).sort()).toEqual(['gu','hi']);
   for(const text of Object.values(shortAudioSamples)){expect(text.normalize('NFC').length).toBeGreaterThan(0);expect(text.length).toBeLessThanOrEqual(100);}
 });
});
