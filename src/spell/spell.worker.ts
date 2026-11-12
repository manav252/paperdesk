/// <reference lib="webworker" />
// Spell checking off the main thread: loads the English dictionary once, then checks whole files and suggests fixes.
import nspell from 'nspell';
import { proseWords } from '../lib/spellText';

type Request =
  | { type: 'init'; aff: string; dic: string; personal: string[] }
  | { type: 'check'; id: number; text: string }
  | { type: 'suggest'; id: number; word: string }
  | { type: 'add'; word: string };

let speller: ReturnType<typeof nspell> | null = null;
let ready: Promise<void> | null = null;

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = async (event: MessageEvent<Request>) => {
  const message = event.data;
  if (message.type === 'init') {
    ready = (async () => {
      const [aff, dic] = await Promise.all([
        fetch(message.aff).then((r) => r.text()),
        fetch(message.dic).then((r) => r.text()),
      ]);
      speller = nspell(aff, dic);
      for (const word of message.personal) speller.add(word);
    })();
    ready.catch((error) => ctx.postMessage({ type: 'error', message: String(error) }));
    return;
  }
  await ready;
  if (!speller) return;
  if (message.type === 'add') {
    speller.add(message.word);
    return;
  }
  if (message.type === 'suggest') {
    ctx.postMessage({ type: 'suggest', id: message.id, suggestions: speller.suggest(message.word).slice(0, 6) });
    return;
  }
  const cache = new Map<string, boolean>();
  const wrong = proseWords(message.text).filter(({ word }) => {
    let ok = cache.get(word);
    // Accept a capitalised form of a known word (sentence starts) and all-caps acronyms.
    if (ok === undefined) {
      ok = word === word.toUpperCase() || speller!.correct(word) || speller!.correct(word.toLowerCase());
      cache.set(word, ok);
    }
    return !ok;
  });
  ctx.postMessage({ type: 'check', id: message.id, words: wrong });
};
