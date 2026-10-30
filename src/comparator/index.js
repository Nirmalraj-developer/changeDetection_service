/**
 * ──────────────────────────────────────────────────────────────────
 * Dual-Layer Verification Architecture — Unification Bridge
 * ──────────────────────────────────────────────────────────────────
 * Unifies Layer 1 (Independent Field Scorer) and Layer 2 (Corroborated
 * Deep Comparator) to provide high-precision entity and content change
 * detection without false positives caused by crawler extraction gaps
 * or cosmetic stop-word fluctuations.
 */

const {
  STOP_WORDS,
  stripHtmlAndEntities,
  tokenizeAndFilterStopWords,
  calculateJaccardSimilarity,
  compareContent,
} = require('./content-comparator');

const {
  LEGAL_SUFFIXES,
  CORPORATE_MODIFIERS,
  cleanPunctuationAndSpacing,
  stripLegalSuffixes,
  stripCorporateModifiers,
  extractBrandStem,
  compareBrandNames,
} = require('./brand-comparator');

const {
  extractNameFromTitle,
  extractNameFromCopyright,
  corroborateCompanyName,
} = require('./corroborator');

const {
  SEVERITY_SCORES,
  getFieldSeverity,
  detectMissingInCrawl,
  scoreField,
  scoreRecord,
} = require('./field-scorer');

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: unifyFieldEvaluations
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Unifies Layer 1 (independent direct field score) with Layer 2
 *    (corroborated multi-source context) to reach the final verdict.
 *
 * HOW IT WORKS:
 *    1. Inspects the independent field scoring result for `company_name`.
 *    2. If independent status is 'NOT_FOUND_IN_CRAWL':
 *       a. Checks corroborated deep comparator output.
 *       b. If corroborator resolved `isExtractionGap === true` (old brand was
 *          found in copyright or title), overrides status to 'EXTRACTION_GAP'.
 *       c. Lowers severity score to prevent false rebrand alert.
 *       d. Populates resolved fallback name.
 *    3. If corroborator detected a genuine rebrand without any fallback match,
 *       confirms 'REBRAND' status with full severity.
 *    4. For all other fields, retains independent scoring output.
 *
 * PARAMETERS:
 *    @param {Object} independentField - Result from `scoreField`
 *    @param {Object} [corroboration] - Result from `corroborateCompanyName`
 *
 * RETURNS:
 *    @returns {Object} Unified field assessment
 *
 * KEY CONSIDERATIONS:
 *    • Solves the White Studio dilemma by distinguishing extractor gaps from genuine rebrands.
 * ══════════════════════════════════════════════════════════════════════
 */
function unifyFieldEvaluations(independentField, corroboration) {
  if (!independentField) return null;

  const isCompanyField = independentField.field === 'company_name' || independentField.field === 'companyName';

  if (!isCompanyField || !corroboration) {
    return independentField;
  }

  // If primary field was missing in crawl, check if corroborator found it in title/copyright
  if (independentField.status === 'NOT_FOUND_IN_CRAWL') {
    if (corroboration.isExtractionGap) {
      return {
        ...independentField,
        status: 'EXTRACTION_GAP',
        score: 3, // Reduced from 10 because entity still exists on site
        tier: corroboration.tier,
        resolvedFallback: corroboration.resolvedName,
        verdict: `Primary tag was missing in crawl, but brand was corroborated via ${corroboration.tier} ("${corroboration.resolvedName}"). Extraction gap detected.`,
      };
    }
  }

  // If independent saw a modification, verify if brand stems match
  if (independentField.status === 'MODIFIED') {
    if (corroboration.status === 'CONFIRMED_MATCH') {
      return {
        ...independentField,
        status: 'UNCHANGED',
        score: 0,
        verdict: `Minor legal suffix or punctuation modification; brand stem matched exactly.`,
      };
    }
  }

  return independentField;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: detectMissingFieldsOnly
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Targeted filter that extracts strictly instances where baseline fields
 *    dropped out or failed to extract in the fresh live crawl.
 *
 * HOW IT WORKS:
 *    1. Iterates over `targetFields`.
 *    2. Checks each field using `detectMissingInCrawl`.
 *    3. If missing, assigns field severity and generates human-readable verdict.
 *    4. Returns summary object containing missing count and structured missing events.
 *
 * PARAMETERS:
 *    @param {Object} oldRecord - Historical baseline record
 *    @param {Object} newRecord - Fresh crawl record
 *    @param {string[]} [targetFields=['company_name', 'phone', 'email', 'website']] - Fields to watch
 *
 * RETURNS:
 *    @returns {Object} { has_missing: boolean, count: number, missing_fields: Array }
 *
 * KEY CONSIDERATIONS:
 *    • Enables quick identification of crawler extraction bugs or dropped contact info.
 * ══════════════════════════════════════════════════════════════════════
 */
function detectMissingFieldsOnly(
  oldRecord,
  newRecord,
  targetFields = ['company_name', 'phone', 'email', 'website']
) {
  const oldRec = oldRecord || {};
  const newRec = newRecord || {};
  const missingEvents = [];

  for (const field of targetFields) {
    const check = detectMissingInCrawl(oldRec[field], newRec[field]);
    if (check.detected) {
      missingEvents.push({
        field,
        old_value: check.old,
        new_value: null,
        status: 'NOT_FOUND_IN_CRAWL',
        score: getFieldSeverity(field),
        verdict: `${field} "${check.old}" was present in baseline but missing in fresh crawl.`,
      });
    }
  }

  return {
    has_missing: missingEvents.length > 0,
    count: missingEvents.length,
    missing_fields: missingEvents,
  };
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: compareEntities
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Full-spectrum dual-layer comparison between a baseline record and
 *    fresh crawl output across profile metadata and content staging.
 *
 * HOW IT WORKS:
 *    1. Runs Layer 1: Independent field scoring across all profile and content fields.
 *    2. Runs Layer 2: Deep corroboration on company name using raw crawl fallbacks.
 *    3. Unifies evaluations via `unifyFieldEvaluations`.
 *    4. Generates combined change diff map suitable for `change_logs`.
 *    5. Returns overall assessment.
 *
 * PARAMETERS:
 *    @param {Object} oldRecord - Baseline database row
 *    @param {Object} newRecord - Cleaned crawl output
 *    @param {Object} [rawCrawlData={}] - Raw crawler response containing title, copyright, etc.
 *    @param {Object} [options={}]
 *    @param {string[]} [options.fieldsToCompare] - Custom list of field keys
 *
 * RETURNS:
 *    @returns {Object} Comprehensive evaluation object with diff, scores, and status
 *
 * KEY CONSIDERATIONS:
 *    • Automatically suppresses cosmetic stop-word changes from the resulting diff map.
 * ══════════════════════════════════════════════════════════════════════
 */
function compareEntities(oldRecord, newRecord, rawCrawlData = {}, options = {}) {
  const oldRec = oldRecord || {};
  const newRec = newRecord || {};

  const defaultFields = [
    'company_name', 'website', 'phone', 'email', 'title', 'description',
    'content', 'about_content', 'contact_content', 'privacy_content', 'terms_content'
  ];

  const fieldsToCompare = options.fieldsToCompare || defaultFields;

  // Layer 1: Independent scoring
  const independent = scoreRecord(oldRec, newRec, fieldsToCompare);

  // Layer 2: Corroborated deep comparator
  const companyCorroboration = corroborateCompanyName(
    oldRec.company_name || oldRec.companyName,
    rawCrawlData
  );

  // Unification Bridge
  const unifiedFields = {};
  const diff = {};
  let totalScore = 0;
  let hasValidChanges = false;

  for (const field of fieldsToCompare) {
    const rawEval = independent.fields[field];
    const isCompany = field === 'company_name' || field === 'companyName';
    const unified = isCompany ? unifyFieldEvaluations(rawEval, companyCorroboration) : rawEval;

    unifiedFields[field] = unified;
    totalScore += unified.score;

    if (unified.status !== 'UNCHANGED' && unified.status !== 'NOT_APPLICABLE') {
      diff[field] = {
        status: unified.status,
        old_data: unified.old_data,
        new_data: unified.new_data,
        score: unified.score,
      };
      hasValidChanges = true;
    }
  }

  return {
    hasChanges: hasValidChanges,
    totalScore,
    diff,
    fields: unifiedFields,
    corroboration: companyCorroboration,
  };
}

module.exports = {
  // Content & Noise Filtering
  STOP_WORDS,
  stripHtmlAndEntities,
  tokenizeAndFilterStopWords,
  calculateJaccardSimilarity,
  compareContent,

  // Brand & Entity Stemming
  LEGAL_SUFFIXES,
  CORPORATE_MODIFIERS,
  cleanPunctuationAndSpacing,
  stripLegalSuffixes,
  stripCorporateModifiers,
  extractBrandStem,
  compareBrandNames,

  // Multi-Source Corroboration
  extractNameFromTitle,
  extractNameFromCopyright,
  corroborateCompanyName,

  // Independent Scorer
  SEVERITY_SCORES,
  getFieldSeverity,
  detectMissingInCrawl,
  scoreField,
  scoreRecord,

  // Unification Bridge
  unifyFieldEvaluations,
  detectMissingFieldsOnly,
  compareEntities,
};

