import { CARD_BANK } from './cards.js';
export { CARD_BANK } from './cards.js';
export const QUESTION_BANK = CARD_BANK;

export function cleanQuestionStarter(value = '') {
  const raw = String(value).trim().replace(/\s+/g, ' ');
  if (!raw || /^_+$/.test(raw)) return '';
  const blanks = raw.match(/_+/g) || [];
  if (blanks.length > 1 || (blanks.length && !/^_+\s*[^_]+$|^[^_]+\s*_+$/.test(raw))) {
    throw new Error('Place one blank before or after the word, for example ____ Field or Elbow ____.');
  }
  const word = raw.replace(/_+/g, '').trim();
  if (!word || word.length > 90) throw new Error('Use a word or short phrase of 1–90 characters.');
  return raw.startsWith('_') ? `____ ${word}` : `${word} ____`;
}
export function promptFromQuery(value = '') {
  try { return cleanQuestionStarter(value) || '____ Word'; } catch { return 'Use ____ Word or Word ____'; }
}

function shuffled(items, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function buildQuestionQueue(count, { includeOriginal = true, includeCustom = false, customQuestions = [], directions = ['before', 'after'], excludedIds = [], random = Math.random } = {}) {
  const selected = new Set(directions.filter((d) => ['before', 'after'].includes(d)));
  if (!selected.size) throw new Error('Choose at least one card type.');
  if (!includeOriginal && !includeCustom) throw new Error('Choose at least one card bank.');
  const custom = includeCustom ? customQuestions.map((item) => {
    const prompt = cleanQuestionStarter(item.query || item.prompt);
    const direction = prompt.startsWith('_') ? 'before' : 'after';
    return { ...item, id: item.id || `custom-${item.questionId}`, word: prompt.replace(/_+/g, '').trim(), direction, query: prompt, prompt };
  }) : [];
  const unique = new Map();
  for (const card of [...(includeOriginal ? CARD_BANK : []), ...custom]) {
    if (selected.has(card.direction)) unique.set(card.prompt.toLowerCase(), card);
  }
  const available = [...unique.values()];
  if (!Number.isInteger(count) || count < 1 || available.length < count) throw new Error(`Only ${available.length} cards fit these choices. Choose fewer rounds or another card bank.`);
  const recent = new Set(excludedIds);
  return [...shuffled(available.filter((c) => !recent.has(c.id)), random), ...shuffled(available.filter((c) => recent.has(c.id)), random)].slice(0, count);
}
