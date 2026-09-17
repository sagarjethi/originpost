import { describe, expect, it } from 'vitest';
import { spokenScript } from '../src/spoken-script.js';

describe('spoken news scripts', () => {
  it.each([
    ['NASA અનુસાર 10 ઉમેદવારોની તાલીમ ચાલુ છે.\nસ્રોત: https://nasa.gov/news\n#સમાચાર #NASA', 'NASA અનુસાર 10 ઉમેદવારોની તાલીમ ચાલુ છે.'],
    ['आज 2 स्कूल खुले।\nस्रोत: www.example.org\n#हिंदी', 'आज 2 स्कूल खुले।'],
    ['According to the council, 2 schools opened.\nSource: https://example.org\n#News', 'According to the council, 2 schools opened.'],
    ['Read [the council statement](https://example.org/news).', 'Read the council statement.'],
    ['The #MeToo allegations remain unverified.', 'The MeToo allegations remain unverified.'],
    ['#અમદાવાદમાં આજે 2 શાળાઓ શરૂ થઈ.', 'અમદાવાદમાં આજે 2 શાળાઓ શરૂ થઈ.'],
    ['Source: NASA said 10 candidates started training.', 'Source: NASA said 10 candidates started training.'],
    ['https://example.org/news।આજે 2 શાળાઓ ખૂલી.', 'આજે 2 શાળાઓ ખૂલી.'],
    ['Route #48 opens at 10:30. The forecast remains uncertain.', 'Route #48 opens at 10:30. The forecast remains uncertain.'],
  ])('removes publishing metadata and preserves spoken facts', (input, expected) => {
    expect(spokenScript(input)).toBe(expected);
    expect(spokenScript(spokenScript(input))).toBe(expected);
  });
  it('returns no narration for a link and hashtag only', () => {
    expect(spokenScript('https://example.org #News')).toBe('');
  });
});
