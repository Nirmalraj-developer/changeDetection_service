/**
 * ──────────────────────────────────────────────────────────────────
 * Independent Field Scorer
 * ──────────────────────────────────────────────────────────────────
 * Evaluates field transitions directly (presence vs absence), classifying
 * each into deterministic states:
 *   - NOT_FOUND_IN_CRAWL (data dropped or crawl failed to extract)
 *   - ADDED              (new field discovered in live crawl)
 *   - UNCHANGED          (validated identical after normalization)
 *   - MODIFIED           (value changed to a different entity)
 *   - NOT_APPLICABLE     (field absent in both snapshots)
 *
 * Assigns severity scores (10 pts for missing company name, 5 pts for contact info).
 */

const { compareContent } = require('./content-comparator');

/**
 * Severity weights for missing field alerts.
 */
const SEVERITY_SCORES = {
  company_name: 10,
  companyName: 10,
  name: 10,
  phone: 5,
  email: 5,
  address: 5,
  website: 3,
  logo: 2,
  description: 2,
  title: 2,
  default: 1,
};

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: getFieldSeverity
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Retrieves the numerical severity weighting for a given field name
 *    when it is detected as missing (NOT_FOUND_IN_CRAWL).
 *
 * HOW IT WORKS:
 *    1. Looks up `field` key in `SEVERITY_SCORES`.
 *    2. Returns matching score, or defaults to 1.
 *
 * PARAMETERS:
 *    @param {string} field - Field name (e.g. 'company_name', 'phone')
 *
 * RETURNS:
 *    @returns {number} Severity score integer (1 to 10)
 *
 * KEY CONSIDERATIONS:
 *    • Company name loss carries highest weight (10) as it suggests rebrand or extractor breakdown.
 * ══════════════════════════════════════════════════════════════════════
 */
function getFieldSeverity(field) {
  return SEVERITY_SCORES[field] || SEVERITY_SCORES.default;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: detectMissingInCrawl
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Standalone pure predicate to test whether a field existed in the baseline
 *    record but was omitted / unextracted in the live crawl.
 *
 * HOW IT WORKS:
 *    1. Validates whether `oldVal` is non-empty.
 *    2. Validates whether `newVal` is non-empty.
 *    3. If `hasOld && !hasNew`, returns `{ detected: true, status: 'NOT_FOUND_IN_CRAWL', old: oldVal, new: null }`.
 *    4. Otherwise returns `{ detected: false }`.
 *
 * PARAMETERS:
 *    @param {any} oldVal - Baseline value
 *    @param {any} newVal - Live crawl value
 *
 * RETURNS:
 *    @returns {Object} { detected: boolean, status?: string, old?: any, new?: null }
 *
 * KEY CONSIDERATIONS:
 *    • Provides lightweight O(1) missing check for filtering pipeline results.
 * ══════════════════════════════════════════════════════════════════════
 */
function detectMissingInCrawl(oldVal, newVal) {
  const hasOld = oldVal !== null && oldVal !== undefined && String(oldVal).trim() !== '';
  const hasNew = newVal !== null && newVal !== undefined && String(newVal).trim() !== '';

  if (hasOld && !hasNew) {
    return {
      detected: true,
      status: 'NOT_FOUND_IN_CRAWL',
      old: oldVal,
      new: null,
    };
  }

  return { detected: false };
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: scoreField
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Evaluates a single field transition between baseline and crawl snapshot,
 *    assigning status, severity score, and structured verdict.
 *
 * HOW IT WORKS:
 *    1. Detects presence of old and new values.
 *    2. If both absent -> status: 'NOT_APPLICABLE', score: 0.
 *    3. If old absent and new present -> status: 'ADDED', score: 1.
 *    4. If old present and new absent -> status: 'NOT_FOUND_IN_CRAWL', score: severity (5-10).
 *    5. If both present:
 *       a. For content fields: runs `compareContent` (strips HTML, stop words, computes Jaccard).
 *          If similarity >= 0.85 -> status: 'UNCHANGED', score: 0.
 *          If similarity < 0.85  -> status: 'MODIFIED', score: 3.
 *       b. For standard fields: compares trimmed strings.
 *          If identical -> status: 'UNCHANGED', score: 0.
 *          If different  -> status: 'MODIFIED', score: 2.
 *    6. Returns structured evaluation object.
 *
 * PARAMETERS:
 *    @param {string} field - Name of field being evaluated
 *    @param {any} oldVal - Historical baseline value
 *    @param {any} newVal - Fresh live crawl value
 *    @param {Object} [options={}]
 *    @param {boolean} [options.isContentField=false] - Apply semantic stop-word token Jaccard
 *
 * RETURNS:
 *    @returns {Object} { field, status, score, old_data, new_data, verdict }
 *
 * KEY CONSIDERATIONS:
 *    • Prevents stop-word content changes from scoring as modifications.
 * ══════════════════════════════════════════════════════════════════════
 */
function scoreField(field, oldVal, newVal, options = {}) {
  const isContent = options.isContentField || false;
  const severity = getFieldSeverity(field);

  const hasOld = oldVal !== null && oldVal !== undefined && String(oldVal).trim() !== '';
  const hasNew = newVal !== null && newVal !== undefined && String(newVal).trim() !== '';

  // 1. Both absent
  if (!hasOld && !hasNew) {
    return {
      field,
      status: 'NOT_APPLICABLE',
      score: 0,
      old_data: null,
      new_data: null,
      verdict: `${field} is absent in both baseline and fresh crawl.`,
    };
  }

  // 2. Discovered in crawl
  if (!hasOld && hasNew) {
    const val = typeof newVal === 'string' ? newVal.trim() : newVal;
    return {
      field,
      status: 'ADDED',
      score: 1,
      old_data: null,
      new_data: val,
      verdict: `Discovered new ${field} in live crawl.`,
    };
  }

  // 3. Dropped out in crawl
  if (hasOld && !hasNew) {
    const val = typeof oldVal === 'string' ? oldVal.trim() : oldVal;
    return {
      field,
      status: 'NOT_FOUND_IN_CRAWL',
      score: severity,
      old_data: val,
      new_data: null,
      verdict: `${field} "${val}" was present in baseline but missing in fresh crawl.`,
    };
  }

  // 4. Both populated - evaluate difference
  const strOld = String(oldVal).trim();
  const strNew = String(newVal).trim();

  if (isContent) {
    const contentResult = compareContent(strOld, strNew, options);
    if (!contentResult.hasChanged) {
      return {
        field,
        status: 'UNCHANGED',
        score: 0,
        similarity: contentResult.similarity,
        old_data: strOld,
        new_data: strNew,
        verdict: `${field} matches baseline (cosmetic stop-word/punctuation differences suppressed).`,
      };
    }
    return {
      field,
      status: 'MODIFIED',
      score: 3,
      similarity: contentResult.similarity,
      old_data: strOld,
      new_data: strNew,
      verdict: `${field} modified with substantive textual change (similarity: ${contentResult.similarity}).`,
    };
  }

  // Standard field string comparison
  if (strOld === strNew) {
    return {
      field,
      status: 'UNCHANGED',
      score: 0,
      old_data: strOld,
      new_data: strNew,
      verdict: `${field} matches baseline exactly.`,
    };
  }

  return {
    field,
    status: 'MODIFIED',
    score: 2,
    old_data: strOld,
    new_data: strNew,
    verdict: `${field} updated from "${strOld}" to "${strNew}".`,
  };
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: scoreRecord
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Scores an entire record across an array of target fields, computing
 *    aggregate severity score and per-field evaluations.
 *
 * HOW IT WORKS:
 *    1. Iterates over `fieldsToScore`.
 *    2. Calls `scoreField` for each field, auto-detecting content fields.
 *    3. Accumulates total score and indexes results by field name.
 *    4. Identifies list of missing fields (`NOT_FOUND_IN_CRAWL`).
 *    5. Returns unified record assessment.
 *
 * PARAMETERS:
 *    @param {Object} oldRecord - Historical baseline record
 *    @param {Object} newRecord - Live crawl record
 *    @param {string[]} fieldsToScore - List of field keys to evaluate
 *
 * RETURNS:
 *    @returns {Object} { totalScore, fields, missingCount, missingFields, hasChanges }
 *
 * KEY CONSIDERATIONS:
 *    • Automatically handles content fields with stop-word Jaccard filtering.
 * ══════════════════════════════════════════════════════════════════════
 */
function scoreRecord(oldRecord, newRecord, fieldsToScore) {
  const oldRec = oldRecord || {};
  const newRec = newRecord || {};

  const contentFieldNames = new Set([
    'content', 'home_content', 'about_content', 'contact_content',
    'privacy_content', 'terms_content'
  ]);

  let totalScore = 0;
  const fields = {};
  const missingFields = [];
  let hasChanges = false;

  for (const field of fieldsToScore) {
    const isContentField = contentFieldNames.has(field);
    const result = scoreField(field, oldRec[field], newRec[field], { isContentField });

    fields[field] = result;
    totalScore += result.score;

    if (result.status === 'NOT_FOUND_IN_CRAWL') {
      missingFields.push(result);
    }

    if (result.status !== 'UNCHANGED' && result.status !== 'NOT_APPLICABLE') {
      hasChanges = true;
    }
  }

  return {
    totalScore,
    fields,
    missingCount: missingFields.length,
    missingFields,
    hasChanges,
  };
}

module.exports = {
  SEVERITY_SCORES,
  getFieldSeverity,
  detectMissingInCrawl,
  scoreField,
  scoreRecord,
};

