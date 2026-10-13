// Search Commands (CommandPalette.swift): what the palette lists, and fuzzy matching as launchers do it.

export type PaletteEntry = { id: string; title: string; shortcut?: string; enabled: boolean; on?: boolean; run: () => void }

const isLetter = (c: string | undefined) => !!c && /\p{L}/u.test(c)
const isWordCharacter = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c)

// Each word starts a word of `title`, in order.
function wordsStartWords(words: string[], title: string) {
  let from = 0
  for (const word of words) {
    let found = -1
    for (let at = title.indexOf(word, from); at >= 0; at = title.indexOf(word, at + 1)) if (at === 0 || !isLetter(title[at - 1])) { found = at + word.length; break }
    if (found < 0) return false
    from = found
  }
  return true
}

// The query's letters must appear in order; each scores, more at the start of a word and more again right after the previous match,
// so "gb" finds Gaussian Blur. How the typed text was found ranks first: whole at a word's start ("lasso" in Lasso), each typed word
// starting a word in order ("new layer" in New Blank Layer), whole inside a word, spaces aside, and last scattered letters. Found the
// same way, a clearly shorter title is the likelier one.
export function paletteScore(query: string, text: string): number | null {
  const wanted = [...query.toLowerCase().replace(/\s/g, '')]
  if (!wanted.length) return 0
  const letters = [...text.toLowerCase()]
  let total = 0, from = 0, previous = -2
  for (const character of wanted) {
    const found = letters.indexOf(character, from)
    if (found < 0) return null
    const wordStart = found === 0 || !isWordCharacter(letters[found - 1])
    total += 1 + (wordStart ? 8 : 0) + (found === previous + 1 ? 5 : 0)
    previous = found
    from = found + 1
  }
  const title = letters.join(''), phrase = query.toLowerCase().trim(), words = phrase.split(' ').filter(Boolean)
  const tier = wordsStartWords([phrase], title) ? 5 : words.length > 1 && wordsStartWords(words, title) ? 4 : title.includes(phrase) ? 3 : title.replace(/ /g, '').includes(wanted.join('')) ? 2 : 1
  return tier * 1_000_000 + (tier === 1 ? total * 100 : 0) - Math.floor(letters.length / 4)
}

// The entries that match, best first, enabled ones ahead of disabled; with no query, all of them in menu order, enabled first.
export function rankPalette(entries: PaletteEntry[], query: string) {
  return entries.flatMap((entry, index) => { const score = paletteScore(query, entry.title); return score === null ? [] : [{ entry, score, index }] })
    .sort((a, b) => a.entry.enabled !== b.entry.enabled ? (a.entry.enabled ? -1 : 1) : !query || a.score === b.score ? a.index - b.index : b.score - a.score)
    .map(found => found.entry)
}
