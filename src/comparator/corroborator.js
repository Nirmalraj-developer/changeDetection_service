/**
 * ──────────────────────────────────────────────────────────────────
 * Multi-Source Corroborator & Fallback Resolver
 * ──────────────────────────────────────────────────────────────────
 * Evaluates whether a missing or altered primary company name is an
 * extraction failure (crawler gap) versus a genuine rebrand or domain
 * abandonment, by cross-checking fallback signals:
 *   1. Primary:   companyName / name (meta tags, schema.org JSON-LD)
 *   2. Secondary: nameFromCopyright ("© 2024 Acme Ltd")
 *   3. Tertiary:  nameFromTitle (<title> before delimiter)
 */

const { extractBrandStem } = require('./brand-comparator');

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: extractNameFromTitle
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Extracts candidate company name from page <title> text by splitting
 *    on common title separators (| - : ~).
 *
 * HOW IT WORKS:
 *    1. Returns null if title is null or not a string.
 *    2. Splits string on standard title delimiters (| - : ~ •).
 *    3. Takes candidate segments, trims whitespace, and ignores generic phrases
 *       ("Home", "Welcome", "Official Site", "Index").
 *    4. Returns first valid candidate company name segment, or null.
 *
 * PARAMETERS:
 *    @param {string|null} title - Raw page <title> string
 *
 * RETURNS:
 *    @returns {string|null} Extracted candidate brand name
 *
 * KEY CONSIDERATIONS:
 *    • Converts "White Studio Bridal | Home" -> "White Studio Bridal".
 * ══════════════════════════════════════════════════════════════════════
 */
function extractNameFromTitle(title) {
  if (!title || typeof title !== 'string') return null;

  const parts = title.split(/[|\-:\~•]/);
  const genericWords = new Set(['home', 'welcome', 'official site', 'official website', 'index', 'about', 'contact']);

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 1 && !genericWords.has(trimmed.toLowerCase())) {
      return trimmed;
    }
  }

  return parts[0] ? parts[0].trim() : null;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: extractNameFromCopyright
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Parses candidate company name from copyright notices found in footer text.
 *
 * HOW IT WORKS:
 *    1. Returns null if input text is null or not a string.
 *    2. Matches patterns like "© 2024 Acme Ltd" or "&copy; Acme Corp. All rights reserved".
 *    3. Strips year digits, "all rights reserved", and symbols.
 *    4. Returns sanitized copyright entity name, or null.
 *
 * PARAMETERS:
 *    @param {string|null} text - Text block or dedicated copyright string
 *
 * RETURNS:
 *    @returns {string|null} Extracted copyright entity name
 *
 * KEY CONSIDERATIONS:
 *    • Provides high-confidence secondary corroboration when meta tags are absent.
 * ══════════════════════════════════════════════════════════════════════
 */
function extractNameFromCopyright(text) {
  if (!text || typeof text !== 'string') return null;

  const match = text.match(/(?:©|&copy;|copyright)\s*(?:\d{4}(?:\s*-\s*\d{4})?)?\s*([^,.\n]+)/i);
  if (match && match[1]) {
    const candidate = match[1]
      .replace(/all rights reserved/i, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (candidate.length > 1 && !/^\d+$/.test(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: corroborateCompanyName
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Validates live crawl results against baseline company name by checking
 *    primary and fallback sources, differentiating extraction failures from rebrands.
 *
 * HOW IT WORKS:
 *    1. Extracts primary name from `rawData.companyName` or `rawData.name`.
 *    2. Extracts secondary name from `rawData.nameFromCopyright` or footer pattern.
 *    3. Extracts tertiary name from `rawData.nameFromTitle` or `extractNameFromTitle(rawData.title)`.
 *    4. Normalizes baseline old name stem via `extractBrandStem`.
 *    5. Evaluation rules:
 *       a. If primary matches old name stem -> status: 'CONFIRMED_MATCH', tier: 'primary'.
 *       b. If primary is null/empty, but secondary or tertiary matches old stem:
 *          -> status: 'EXTRACTION_GAP', tier: 'secondary' | 'tertiary'.
 *          (Indicates the crawler missed the primary tag, but the company is intact).
 *       c. If primary is null and all fallbacks are null/empty:
 *          -> status: 'NOT_FOUND_IN_CRAWL', tier: 'not_found'.
 *       d. If primary is populated with a completely different stem and no fallbacks match:
 *          -> status: 'REBRAND', tier: 'primary'.
 *
 * PARAMETERS:
 *    @param {string|null} oldName - Baseline company name from database
 *    @param {Object|null} rawData - Fresh crawl data object from crawler API
 *
 * RETURNS:
 *    @returns {Object} { status, tier, isExtractionGap, isRebrand, resolvedName, candidates }
 *
 * KEY CONSIDERATIONS:
 *    • Resolves issues like "White Studio" where primary meta tag was null
 *      but title or copyright still contained the valid brand.
 * ══════════════════════════════════════════════════════════════════════
 */
function corroborateCompanyName(oldName, rawData) {
  if (!rawData || typeof rawData !== 'object') {
    return {
      status: oldName ? 'NOT_FOUND_IN_CRAWL' : 'NOT_APPLICABLE',
      tier: 'not_found',
      isExtractionGap: false,
      isRebrand: false,
      resolvedName: null,
      candidates: { primary: null, secondary: null, tertiary: null },
    };
  }

  // 1. Resolve candidates across multi-source hierarchy
  const primary = rawData.companyName || rawData.name || null;
  const secondary = rawData.nameFromCopyright || extractNameFromCopyright(rawData.footerContent || rawData.homeContent) || null;
  const tertiary = rawData.nameFromTitle || extractNameFromTitle(rawData.title) || null;

  const candidates = { primary, secondary, tertiary };

  const oldStem = extractBrandStem(oldName);
  const primaryStem = extractBrandStem(primary);
  const secondaryStem = extractBrandStem(secondary);
  const tertiaryStem = extractBrandStem(tertiary);

  // If old name was not populated
  if (!oldStem) {
    const resolved = primary || secondary || tertiary || null;
    return {
      status: resolved ? 'ADDED' : 'NOT_APPLICABLE',
      tier: primary ? 'primary' : secondary ? 'secondary' : tertiary ? 'tertiary' : 'not_found',
      isExtractionGap: false,
      isRebrand: false,
      resolvedName: resolved,
      candidates,
    };
  }

  // Check 1: Primary match
  if (primaryStem && primaryStem === oldStem) {
    return {
      status: 'CONFIRMED_MATCH',
      tier: 'primary',
      isExtractionGap: false,
      isRebrand: false,
      resolvedName: primary,
      candidates,
    };
  }

  // Check 2: Primary missing, but secondary (copyright) confirms old brand
  if (!primaryStem && secondaryStem && secondaryStem.includes(oldStem)) {
    return {
      status: 'EXTRACTION_GAP',
      tier: 'secondary',
      isExtractionGap: true,
      isRebrand: false,
      resolvedName: secondary,
      candidates,
    };
  }

  // Check 3: Primary missing, but tertiary (title) confirms old brand
  if (!primaryStem && tertiaryStem && tertiaryStem.includes(oldStem)) {
    return {
      status: 'EXTRACTION_GAP',
      tier: 'tertiary',
      isExtractionGap: true,
      isRebrand: false,
      resolvedName: tertiary,
      candidates,
    };
  }

  // Check 4: Primary is null and no fallback confirms
  if (!primaryStem) {
    return {
      status: 'NOT_FOUND_IN_CRAWL',
      tier: 'not_found',
      isExtractionGap: false,
      isRebrand: false,
      resolvedName: null,
      candidates,
    };
  }

  // Check 5: Primary is populated with a completely different brand
  return {
    status: 'REBRAND',
    tier: 'primary',
    isExtractionGap: false,
    isRebrand: true,
    resolvedName: primary,
    candidates,
  };
}

module.exports = {
  extractNameFromTitle,
  extractNameFromCopyright,
  corroborateCompanyName,
};

