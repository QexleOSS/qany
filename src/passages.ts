// Passage carving: split page text into bounded windows and score windows
// against query tokens, so a dense answering paragraph outranks a long page
// where the words only scatter.
const WINDOW_CHARS = 900;
const STEP_CHARS = 600;

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
}

export function splitPassages(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const passages: string[] = [];
  let buffer: string[] = [];
  let length = 0;
  const flush = () => {
    if (buffer.length > 0) {
      passages.push(buffer.join(" "));
      buffer = [];
      length = 0;
    }
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > WINDOW_CHARS) {
      flush();
      for (
        let at = 0;
        at + WINDOW_CHARS > STEP_CHARS && at < paragraph.length;
        at += STEP_CHARS
      ) {
        const end = Math.min(at + WINDOW_CHARS, paragraph.length);
        passages.push(paragraph.slice(at, end));
        if (end === paragraph.length) break;
      }
      continue;
    }
    if (length + paragraph.length + 1 > WINDOW_CHARS) flush();
    buffer.push(paragraph);
    length += paragraph.length + 1;
  }
  flush();
  // A paragraph boundary right after an oversized paragraph can leave a tiny
  // fragment window; BM25 hands tiny windows runaway boosts, so glue them to
  // the nearest neighbour.
  const merged: string[] = [];
  for (const passage of passages) {
    const last = merged[merged.length - 1];
    if (last !== undefined && passage.length < 200) {
      merged[merged.length - 1] = `${last}\n\n${passage}`;
    } else {
      merged.push(passage);
    }
  }
  return merged;
}

// distinct tokens in a window weigh 3 each; repeats beyond the first add 1,
// capped so a page spamming one word cannot outscore real coverage.
export function bestPassage(
  text: string,
  tokens: string[],
): { passage: string; score: number } {
  const flat = text.replace(/\s+/g, " ").trim();
  const passages = flat.length <= WINDOW_CHARS ? [flat] : splitPassages(text);
  let best = { passage: "", score: 0 };
  for (const passage of passages) {
    const lower = passage.toLowerCase();
    let distinct = 0;
    let extra = 0;
    for (const token of tokens) {
      if (!token) continue;
      const hits = countOccurrences(lower, token);
      if (hits > 0) {
        distinct += 1;
        extra += Math.min(hits - 1, 2);
      }
    }
    const score = distinct * 3 + extra;
    if (score > best.score) best = { passage, score };
  }
  return best;
}
