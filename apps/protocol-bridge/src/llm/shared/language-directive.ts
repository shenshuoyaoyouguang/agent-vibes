/**
 * Forced language directive.
 *
 * The bridge sits between the Cursor IDE (and other Anthropic-format clients)
 * and every LLM backend. Models — especially in interleaved thinking blocks —
 * tend to drift to English even when the user is clearly writing in another
 * language. To enforce language consistency we inject an explicit directive
 * into the system prompt of every backend.
 *
 * This module is intentionally dependency-free and format-agnostic:
 *   - `detectLanguageFromText` / `detectUserLanguage` do script-based Unicode
 *     detection (plus a conservative Latin-script stopword pass) with no
 *     external NLP dependency.
 *   - `buildLanguageDirective` produces the directive text, naming the
 *     detected language explicitly when possible (e.g. "The user is currently
 *     writing in Chinese") and falling back to a generic directive otherwise.
 *   - `appendLanguageDirectiveToText` / `appendLanguageDirectiveToAnthropicSystem`
 *     merge the directive into the two system-prompt shapes the backends use
 *     (a plain string, or an Anthropic `system` value that may be a string or
 *     an array of content blocks).
 *
 * All public functions accept `messages: unknown` so call sites can pass their
 * backend-native message arrays (Anthropic DTO messages, Codex messages, the
 * raw cloned payload's messages) without type friction; non-array / malformed
 * input degrades gracefully to the generic directive.
 */

export interface DetectedLanguage {
  /** Short language code, e.g. "zh", "ja". Used for logging / tests. */
  code: string
  /** English display name used in the directive text, e.g. "Chinese". */
  englishName: string
}

interface LooseMessage {
  role?: unknown
  content?: unknown
}

/**
 * Content-block types that never carry human-authored prose and therefore must
 * be ignored when sampling the user's language (tool plumbing, images, model
 * reasoning echoed back into the transcript).
 */
const NON_PROSE_BLOCK_TYPES = new Set([
  "tool_result",
  "tool_use",
  "image",
  "thinking",
  "redacted_thinking",
])

function isHan(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) || // Extension A
    (cp >= 0x20000 && cp <= 0x2a6df) || // Extension B
    (cp >= 0xf900 && cp <= 0xfaff) // CJK Compatibility Ideographs
  )
}

function isHangul(cp: number): boolean {
  return (
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
    (cp >= 0x3130 && cp <= 0x318f) // Hangul Compatibility Jamo
  )
}

function isLatinLetter(cp: number): boolean {
  return (
    (cp >= 0x41 && cp <= 0x5a) || // A-Z
    (cp >= 0x61 && cp <= 0x7a) || // a-z
    (cp >= 0xc0 && cp <= 0x24f) // Latin-1 Supplement + Latin Extended-A/B letters
  )
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return ""
  }
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block)
      continue
    }
    if (block && typeof block === "object") {
      const record = block as Record<string, unknown>
      const type = typeof record.type === "string" ? record.type : ""
      if (NON_PROSE_BLOCK_TYPES.has(type)) {
        continue
      }
      if (typeof record.text === "string") {
        parts.push(record.text)
      }
    }
  }
  return parts.join(" ")
}

/**
 * Returns the prose of the most recent genuine user turn. Tool-result-only
 * user turns (agentic mid-loop) are skipped so the detected language stays
 * stable across tool calls instead of flipping to "" between turns.
 */
export function extractLatestUserText(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return ""
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as LooseMessage | undefined
    if (!message || typeof message !== "object") {
      continue
    }
    if (message.role !== "user") {
      continue
    }
    const text = extractTextFromContent(message.content).trim()
    if (text) {
      return text
    }
  }
  return ""
}

interface LatinStopwordSet {
  language: DetectedLanguage
  words: ReadonlySet<string>
}

const LATIN_STOPWORD_SETS: readonly LatinStopwordSet[] = [
  {
    language: { code: "es", englishName: "Spanish" },
    words: new Set([
      "el",
      "la",
      "los",
      "las",
      "una",
      "por",
      "para",
      "con",
      "que",
      "como",
      "pero",
      "más",
      "está",
      "gracias",
      "hola",
      "porque",
      "esto",
      "muy",
    ]),
  },
  {
    language: { code: "fr", englishName: "French" },
    words: new Set([
      "le",
      "les",
      "une",
      "des",
      "est",
      "pour",
      "avec",
      "que",
      "mais",
      "vous",
      "bonjour",
      "merci",
      "être",
      "parce",
      "cette",
      "très",
      "dans",
    ]),
  },
  {
    language: { code: "de", englishName: "German" },
    words: new Set([
      "der",
      "die",
      "das",
      "und",
      "ist",
      "nicht",
      "mit",
      "ein",
      "eine",
      "für",
      "ich",
      "danke",
      "hallo",
      "wie",
      "auch",
      "aber",
      "noch",
      "wird",
    ]),
  },
  {
    language: { code: "pt", englishName: "Portuguese" },
    words: new Set([
      "não",
      "uma",
      "com",
      "que",
      "para",
      "como",
      "obrigado",
      "olá",
      "você",
      "mais",
      "está",
      "porque",
      "também",
      "isso",
      "muito",
    ]),
  },
  {
    language: { code: "it", englishName: "Italian" },
    words: new Set([
      "il",
      "che",
      "non",
      "per",
      "con",
      "una",
      "sono",
      "grazie",
      "ciao",
      "perché",
      "anche",
      "questo",
      "molto",
      "come",
      "sei",
    ]),
  },
]

/**
 * Conservative Latin-script language detection. Counts distinct stopword hits
 * per language and only names a language when one set wins clearly (at least
 * two distinct hits AND strictly more than the runner-up). Ambiguous or
 * English-looking text returns null, falling back to the generic directive.
 */
function detectLatinLanguage(text: string): DetectedLanguage | null {
  const tokens = text.toLowerCase().split(/[^a-z\u00c0-\u024f']+/u)
  const seen = new Set<string>()
  for (const token of tokens) {
    if (token) {
      seen.add(token)
    }
  }
  if (seen.size === 0) {
    return null
  }
  let best: DetectedLanguage | null = null
  let bestHits = 0
  let runnerUpHits = 0
  for (const set of LATIN_STOPWORD_SETS) {
    let hits = 0
    for (const word of set.words) {
      if (seen.has(word)) {
        hits++
      }
    }
    if (hits > bestHits) {
      runnerUpHits = bestHits
      bestHits = hits
      best = set.language
    } else if (hits > runnerUpHits) {
      runnerUpHits = hits
    }
  }
  if (bestHits >= 2 && bestHits > runnerUpHits) {
    return best
  }
  return null
}

/**
 * Detect the language of a raw text sample. Non-Latin scripts are named
 * directly (high confidence); predominantly Latin text falls back to a
 * conservative stopword pass. Returns null when no language can be named with
 * confidence (including plain English, which is the model default anyway).
 */
export function detectLanguageFromText(text: string): DetectedLanguage | null {
  if (!text) {
    return null
  }

  let han = 0
  let hiragana = 0
  let katakana = 0
  let hangul = 0
  let cyrillic = 0
  let arabic = 0
  let hebrew = 0
  let devanagari = 0
  let thai = 0
  let greek = 0
  let latin = 0

  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (isHan(cp)) {
      han++
    } else if (cp >= 0x3040 && cp <= 0x309f) {
      hiragana++
    } else if (cp >= 0x30a0 && cp <= 0x30ff) {
      katakana++
    } else if (isHangul(cp)) {
      hangul++
    } else if (cp >= 0x0400 && cp <= 0x04ff) {
      cyrillic++
    } else if (
      (cp >= 0x0600 && cp <= 0x06ff) ||
      (cp >= 0x0750 && cp <= 0x077f)
    ) {
      arabic++
    } else if (cp >= 0x0590 && cp <= 0x05ff) {
      hebrew++
    } else if (cp >= 0x0900 && cp <= 0x097f) {
      devanagari++
    } else if (cp >= 0x0e00 && cp <= 0x0e7f) {
      thai++
    } else if (cp >= 0x0370 && cp <= 0x03ff) {
      greek++
    } else if (isLatinLetter(cp)) {
      latin++
    }
  }

  const kana = hiragana + katakana
  const nonLatin =
    han + kana + hangul + cyrillic + arabic + hebrew + devanagari + thai + greek
  const totalLetters = nonLatin + latin
  if (totalLetters === 0) {
    return null
  }

  // Treat the message as non-Latin-script when EITHER a meaningful share of
  // letters are non-Latin (ratio gate) OR there is a non-trivial absolute
  // count of non-Latin letters (floor gate). The floor is what makes detection
  // robust for developer messages: real prose in another script (e.g. Chinese)
  // routinely sits alongside long ASCII spans — file paths, code, URLs, log
  // lines — that drag the ratio well under 20% even though the user is clearly
  // writing in that language. A stray single ideograph quoted inside an English
  // sentence stays under the floor and correctly falls through to Latin
  // detection.
  const NON_LATIN_FLOOR = 4
  if (nonLatin >= NON_LATIN_FLOOR || nonLatin >= 0.2 * totalLetters) {
    // Japanese is a mix of kanji (Han) and kana. Treat the text as Japanese
    // only when kana is a meaningful share of the CJK letters — this catches
    // genuine Japanese (which is kana-heavy) while a stray quoted kana inside
    // an otherwise Chinese/other blob stays below the threshold and does NOT
    // flip the result. Kanji-only text is inherently ambiguous and reads as
    // Chinese, which is the accepted default here.
    const cjk = han + kana
    if (kana > 0 && kana >= 0.15 * cjk) {
      return { code: "ja", englishName: "Japanese" }
    }
    // Pick the dominant non-Latin script by character count. Using the max
    // count (instead of an early return on the mere presence of a script) is
    // what stops a minority of leaked characters — e.g. a few Hangul or Han
    // chars from quoted text or a context/memory attachment — from overriding
    // the language the user is actually writing in.
    const candidates: ReadonlyArray<readonly [number, DetectedLanguage]> = [
      [han, { code: "zh", englishName: "Chinese" }],
      [hangul, { code: "ko", englishName: "Korean" }],
      [cyrillic, { code: "ru", englishName: "Russian" }],
      [arabic, { code: "ar", englishName: "Arabic" }],
      [hebrew, { code: "he", englishName: "Hebrew" }],
      [devanagari, { code: "hi", englishName: "Hindi" }],
      [thai, { code: "th", englishName: "Thai" }],
      [greek, { code: "el", englishName: "Greek" }],
    ]
    let winner = candidates[0]!
    for (const candidate of candidates) {
      if (candidate[0] > winner[0]) {
        winner = candidate
      }
    }
    if (winner[0] > 0) {
      return winner[1]
    }
  }

  return detectLatinLanguage(text)
}

/** Detect the user's language from a backend-native message array. */
export function detectUserLanguage(messages: unknown): DetectedLanguage | null {
  return detectLanguageFromText(extractLatestUserText(messages))
}

const GENERIC_DIRECTIVE = [
  "Language usage rules:",
  "- Always respond in the same language the user is writing in.",
  "- Your internal thinking and reasoning (think/thought blocks) must also use the user's language.",
  "- Match the user's language consistently throughout the entire conversation, including explanations, summaries, and follow-up questions.",
  "- Do not switch languages unless the user explicitly asks you to.",
  "- Exception: code comments and commit messages default to English unless the user specifies otherwise.",
].join("\n")

function buildNamedDirective(name: string): string {
  return [
    `The user is currently writing in ${name}. You MUST respond in ${name}.`,
    "",
    "Language usage rules:",
    `- Respond in ${name} — the language the user is currently writing in.`,
    `- Your internal thinking and reasoning (think/thought blocks) MUST also be written in ${name}, never English.`,
    `- Keep ${name} consistent across the entire turn: thinking, explanations, summaries, and follow-up questions.`,
    "- Do not switch to another language unless the user explicitly asks you to.",
    "- Exception: code, code comments, identifiers, and commit messages follow their normal conventions (usually English) unless the user specifies otherwise.",
  ].join("\n")
}

/**
 * Build the language directive for a request. Names the detected language
 * explicitly when confident; otherwise returns the generic directive.
 */
export function buildLanguageDirective(messages: unknown): string {
  const detected = detectUserLanguage(messages)
  return detected
    ? buildNamedDirective(detected.englishName)
    : GENERIC_DIRECTIVE
}

/**
 * Append the language directive to a plain-string system prompt (Codex
 * instructions, Kiro/Bedrock embedded system prompt). Safe on empty input.
 */
export function appendLanguageDirectiveToText(
  base: string | null | undefined,
  messages: unknown
): string {
  const directive = buildLanguageDirective(messages)
  const trimmed = (base ?? "").trim()
  return trimmed ? `${trimmed}\n\n${directive}` : directive
}

/**
 * Append the language directive to an Anthropic `system` value, which may be a
 * plain string or an array of content blocks. Returns the same broad shape so
 * the caller can assign it straight back onto the request payload.
 */
export function appendLanguageDirectiveToAnthropicSystem(
  system: unknown,
  messages: unknown
): string | Array<Record<string, unknown>> {
  const directive = buildLanguageDirective(messages)
  if (Array.isArray(system)) {
    return [
      ...(system as Array<Record<string, unknown>>),
      { type: "text", text: directive },
    ]
  }
  const base = typeof system === "string" ? system.trim() : ""
  return base ? `${base}\n\n${directive}` : directive
}
