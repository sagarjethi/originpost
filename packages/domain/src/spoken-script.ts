const metadataLabel = /^\s*(?:sources?|links?|hashtags?|સ્રોત|સ્ત્રોત|સોર્સ|લિંક|स्रोत|लिंक)\s*[:：]\s*$/iu;
const hashtagOnly = /^(?:[#＃][\p{L}\p{M}_][\p{L}\p{M}\p{N}_]*\s*)+$/u;

/** Prepare social copy for speech without changing names, numbers or attribution in prose. */
export function spokenScript(value: string): string {
  return value.normalize('NFC')
    .replace(/!\[[^\]]*\]\([^\n)]*\)/gu, '')
    .replace(/\[([^\]\n]+)\]\((?:https?:\/\/|www\.)[^\n)]*\)/giu, '$1')
    .split('\n')
    .map(line => {
      const withoutLinks = line
        .replace(/(?:https?:\/\/|www\.)[^\s<>।॥]+/giu, url => url.match(/[.,;:!?]+$/u)?.[0] ?? '')
        .replace(/[\t ]+/gu, ' ').trim().replace(/^[।॥]+/u, '');
      if (hashtagOnly.test(withoutLinks) || metadataLabel.test(withoutLinks) || /^[.,;:!?।॥]*$/u.test(withoutLinks)) return '';
      // A hashtag in prose can carry a place or topic: retain the word for speech.
      return withoutLinks.replace(/(^|[\s(])[#＃](?=[\p{L}\p{M}_])/gu, '$1');
    })
    .join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}
