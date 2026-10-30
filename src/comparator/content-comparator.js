/**
 * ──────────────────────────────────────────────────────────────────
 * Content Comparator & Semantic Noise Filter
 * ──────────────────────────────────────────────────────────────────
 * Compares large text bodies (home content, about, contact, privacy,
 * terms) by stripping HTML tags, entities, punctuation, and grammatical
 * filler words ("the", "is", "not in", "there was", etc.).
 *
 * Employs Token Jaccard similarity with an 85% threshold to suppress
 * cosmetic wording updates, preventing false-positive database writes.
 */

/**
 * Comprehensive set of English stop words and grammatical fillers.
 * Changes consisting exclusively of these words are classified as cosmetic.
 */
const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
  'any', 'are', 'aren', 'as', 'at', 'be', 'because', 'been', 'before', 'being',
  'below', 'between', 'both', 'but', 'by', 'can', 'cannot', 'could', 'did',
  'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from',
  'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers',
  'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is',
  'isn', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'myself',
  'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
  'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she',
  'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs',
  'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'wasn', 'we',
  'were', 'weren', 'what', 'when', 'where', 'which', 'while', 'who', 'whom',
  'why', 'with', 'won', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves'
]);

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: stripHtmlAndEntities
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Removes all HTML tags, script/style remnants, and HTML entities
 *    from scraped page content prior to lexical comparison.
 *
 * HOW IT WORKS:
 *    1. Returns an empty string if input is null, undefined, or non-string.
 *    2. Replaces HTML tags (<tag> ... </tag>) with whitespace.
 *    3. Replaces named and numerical HTML entities (&amp;, &#39;, &nbsp;) with whitespace.
 *    4. Collapses repeated whitespace down to a single space.
 *
 * PARAMETERS:
 *    @param {string|null} text - Raw text or HTML markup to clean
 *
 * RETURNS:
 *    @returns {string} Plain text with markup and entities stripped
 *
 * KEY CONSIDERATIONS:
 *    • Prevents HTML structure differences from causing false-positive text diffs.
 * ══════════════════════════════════════════════════════════════════════
 */
function stripHtmlAndEntities(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: tokenizeAndFilterStopWords
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Converts text into a unique Set of meaningful semantic tokens by
 *    filtering out punctuation, numbers, single characters, and stop words.
 *
 * HOW IT WORKS:
 *    1. Strips HTML markup and entities via `stripHtmlAndEntities`.
 *    2. Converts to lowercase and replaces non-alphanumeric chars with spaces.
 *    3. Splits string into individual word tokens.
 *    4. Evaluates each word: drops pure numeric tokens, tokens with length < 2,
 *       and words present in `STOP_WORDS`.
 *    5. Returns a Set of unique semantic tokens.
 *
 * PARAMETERS:
 *    @param {string|null} text - Raw text to tokenize
 *
 * RETURNS:
 *    @returns {Set<string>} Unique set of semantic word tokens
 *
 * KEY CONSIDERATIONS:
 *    • Changes involving only "the", "is", "there was", "not in" are filtered out
 *      completely because their tokens are excluded from the resulting set.
 * ══════════════════════════════════════════════════════════════════════
 */
function tokenizeAndFilterStopWords(text) {
  const clean = stripHtmlAndEntities(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) return new Set();

  const words = clean.split(' ');
  const tokens = new Set();

  for (const word of words) {
    if (word.length > 1 && !STOP_WORDS.has(word) && !/^\d+$/.test(word)) {
      tokens.add(word);
    }
  }

  return tokens;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: calculateJaccardSimilarity
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Calculates the Token Jaccard similarity coefficient between two
 *    token sets, returning a metric between 0.0 (disjoint) and 1.0 (identical).
 *
 * HOW IT WORKS:
 *    1. If both sets are empty, returns 1.0 (both empty is equivalent).
 *    2. If only one set is empty, returns 0.0.
 *    3. Calculates intersection size by checking presence of each token from set A in set B.
 *    4. Calculates union size: setA.size + setB.size - intersection.
 *    5. Returns intersection / union.
 *
 * PARAMETERS:
 *    @param {Set<string>} setA - First token set
 *    @param {Set<string>} setB - Second token set
 *
 * RETURNS:
 *    @returns {number} Floating point coefficient between 0.0 and 1.0
 *
 * KEY CONSIDERATIONS:
 *    • O(min(|A|, |B|)) set lookup performance makes it suitable for streaming workloads.
 * ══════════════════════════════════════════════════════════════════════
 */
function calculateJaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersectionCount = 0;
  const [smaller, larger] = setA.size < setB.size ? [setA, setB] : [setB, setA];

  for (const token of smaller) {
    if (larger.has(token)) {
      intersectionCount++;
    }
  }

  const unionCount = setA.size + setB.size - intersectionCount;
  return unionCount === 0 ? 1.0 : intersectionCount / unionCount;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: compareContent
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Determines whether a scraped page content field underwent a substantive,
 *    genuine change, or whether the change was cosmetic / filler wording.
 *
 * HOW IT WORKS:
 *    1. Normalizes empty strings, null, and undefined values to null.
 *    2. If both are null, returns { hasChanged: false, status: 'NOT_APPLICABLE' }.
 *    3. If old is null and new exists, returns { hasChanged: true, status: 'ADDED' }.
 *    4. If old exists and new is null, returns { hasChanged: true, status: 'NOT_FOUND_IN_CRAWL' }.
 *    5. If exact trimmed strings match, returns { hasChanged: false, status: 'UNCHANGED', similarity: 1.0 }.
 *    6. Extracts filtered semantic token sets (excluding stop words like "the", "is", "there was", etc.).
 *    7. Calculates Token Jaccard similarity.
 *    8. If similarity >= threshold (default: 0.85), marks as 'UNCHANGED' and suppresses change.
 *    9. If similarity < threshold, marks as 'MODIFIED' with genuine difference.
 *
 * PARAMETERS:
 *    @param {string|null} oldText - Baseline text stored in database
 *    @param {string|null} newText - Freshly scraped text from live crawl
 *    @param {Object} [options={}]
 *    @param {number} [options.similarityThreshold=0.85] - Jaccard cutoff for cosmetic suppression
 *
 * RETURNS:
 *    @returns {Object} Evaluation result: { hasChanged, status, similarity, old_data, new_data }
 *
 * KEY CONSIDERATIONS:
 *    • Ignores trivial filler edits like "there was an office" -> "there is an office".
 *    • Only substantial textual shifts register as a change in change_logs.
 * ══════════════════════════════════════════════════════════════════════
 */
function compareContent(oldText, newText, options = {}) {
  const threshold = options.similarityThreshold !== undefined ? options.similarityThreshold : 0.85;

  const hasOld = oldText !== null && oldText !== undefined && String(oldText).trim() !== '';
  const hasNew = newText !== null && newText !== undefined && String(newText).trim() !== '';

  if (!hasOld && !hasNew) {
    return { hasChanged: false, status: 'NOT_APPLICABLE', similarity: 1.0 };
  }

  if (!hasOld && hasNew) {
    return {
      hasChanged: true,
      status: 'ADDED',
      similarity: 0.0,
      old_data: null,
      new_data: String(newText).trim(),
    };
  }

  if (hasOld && !hasNew) {
    return {
      hasChanged: true,
      status: 'NOT_FOUND_IN_CRAWL',
      similarity: 0.0,
      old_data: String(oldText).trim(),
      new_data: null,
    };
  }

  const strOld = String(oldText).trim();
  const strNew = String(newText).trim();

  // Fast-path: exact match after trimming
  if (strOld === strNew) {
    return { hasChanged: false, status: 'UNCHANGED', similarity: 1.0 };
  }

  // Tokenize and filter noise words
  const tokensOld = tokenizeAndFilterStopWords(strOld);
  const tokensNew = tokenizeAndFilterStopWords(strNew);

  const similarity = calculateJaccardSimilarity(tokensOld, tokensNew);

  // If semantic similarity exceeds threshold, cosmetic differences are suppressed
  if (similarity >= threshold) {
    return {
      hasChanged: false,
      status: 'UNCHANGED',
      similarity: Math.round(similarity * 1000) / 1000,
    };
  }

  return {
    hasChanged: true,
    status: 'MODIFIED',
    similarity: Math.round(similarity * 1000) / 1000,
    old_data: strOld,
    new_data: strNew,
  };
}

module.exports = {
  STOP_WORDS,
  stripHtmlAndEntities,
  tokenizeAndFilterStopWords,
  calculateJaccardSimilarity,
  compareContent,
};

