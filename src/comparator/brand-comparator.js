/**
 * ──────────────────────────────────────────────────────────────────
 * Brand Comparator & Entity Stem Normalizer
 * ──────────────────────────────────────────────────────────────────
 * Strips corporate legal suffixes (Ltd, LLC, Pvt Ltd, Inc) and generic
 * business modifiers (Group, Technologies, Holdings) to compare company
 * names at their canonical brand root.
 */

/**
 * Common corporate legal entity suffixes across major jurisdictions.
 */
const LEGAL_SUFFIXES = [
  'private limited', 'pvt ltd', 'pvt. ltd.', 'limited liability partnership',
  'limited liability company', 'limited', 'ltd', 'l.t.d.', 'incorporated',
  'inc', 'inc.', 'corporation', 'corp', 'corp.', 'llc', 'l.l.c.', 'llp',
  'gmbh', 'plc', 'p.l.c.', 'bv', 'b.v.', 'sarl', 's.a.r.l.', 'sa', 's.a.',
  'spa', 's.p.a.', 'co', 'co.', 'company'
];

/**
 * Generic corporate modifiers frequently added or dropped without a true rebrand.
 */
const CORPORATE_MODIFIERS = [
  'group', 'technologies', 'technology', 'tech', 'holdings', 'ventures',
  'solutions', 'services', 'enterprises', 'international', 'global',
  'consulting', 'partners', 'associates'
];

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: cleanPunctuationAndSpacing
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Sanitizes raw company name strings by converting to lowercase,
 *    replacing punctuation with spaces, and normalizing spaces.
 *
 * HOW IT WORKS:
 *    1. Returns empty string if input is falsy or not a string.
 *    2. Converts string to lowercase.
 *    3. Replaces non-word and non-whitespace characters with spaces.
 *    4. Collapses multiple contiguous spaces into a single space.
 *    5. Trims leading and trailing whitespace.
 *
 * PARAMETERS:
 *    @param {string|null} name - Raw company or brand name
 *
 * RETURNS:
 *    @returns {string} Sanitized lowercase string
 *
 * KEY CONSIDERATIONS:
 *    • Ensures consistent word boundaries for regex suffix matching.
 * ══════════════════════════════════════════════════════════════════════
 */
function cleanPunctuationAndSpacing(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: stripLegalSuffixes
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Iteratively strips right-anchored legal entity designations from
 *    a cleaned company name string.
 *
 * HOW IT WORKS:
 *    1. Takes pre-cleaned lowercase string.
 *    2. Iterates in a loop checking each suffix in `LEGAL_SUFFIXES`.
 *    3. Matches suffix against the end of the string using word boundary `\b<suffix>$`.
 *    4. If matched, removes suffix, trims, and repeats until no further suffixes match.
 *    5. Returns cleaned name stripped of corporate designations.
 *
 * PARAMETERS:
 *    @param {string} cleanedName - Punctuation-stripped lowercase name
 *
 * RETURNS:
 *    @returns {string} Name string without legal entity suffixes
 *
 * KEY CONSIDERATIONS:
 *    • Loops to handle chained designations such as "Company Ltd" -> "".
 * ══════════════════════════════════════════════════════════════════════
 */
function stripLegalSuffixes(cleanedName) {
  let str = cleanedName;
  let changed = true;

  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      const escaped = suffix.replace('.', '\\.');
      const re = new RegExp(`\\b${escaped}\\b$`, 'i');
      if (re.test(str)) {
        str = str.replace(re, '').trim();
        changed = true;
      }
    }
  }

  return str;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: stripCorporateModifiers
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Strips generic corporate business modifiers (e.g. Group, Holdings)
 *    from the end of a company name to identify the core brand root.
 *
 * HOW IT WORKS:
 *    1. Takes string (typically already stripped of legal suffixes).
 *    2. Checks each modifier in `CORPORATE_MODIFIERS`.
 *    3. Matches modifier against end of string with word boundary `\b<modifier>$`.
 *    4. If matched, removes modifier and trims.
 *    5. Returns core brand root.
 *
 * PARAMETERS:
 *    @param {string} str - String without legal suffixes
 *
 * RETURNS:
 *    @returns {string} Brand root without generic corporate modifiers
 *
 * KEY CONSIDERATIONS:
 *    • Does not remove modifiers if they constitute the entire name.
 * ══════════════════════════════════════════════════════════════════════
 */
function stripCorporateModifiers(str) {
  let result = str;
  for (const mod of CORPORATE_MODIFIERS) {
    const re = new RegExp(`\\b${mod}\\b$`, 'i');
    if (re.test(result)) {
      const candidate = result.replace(re, '').trim();
      // Ensure we do not reduce a company name to an empty string
      if (candidate.length > 0) {
        result = candidate;
      }
    }
  }
  return result;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: extractBrandStem
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Extracts the canonical brand stem from any company name string
 *    by executing the complete normalization pipeline.
 *
 * HOW IT WORKS:
 *    1. Cleans punctuation and whitespace via `cleanPunctuationAndSpacing`.
 *    2. Strips legal suffixes via `stripLegalSuffixes`.
 *    3. Strips corporate modifiers via `stripCorporateModifiers`.
 *    4. Returns final normalized brand stem.
 *
 * PARAMETERS:
 *    @param {string|null} name - Raw company name
 *
 * RETURNS:
 *    @returns {string} Canonical brand stem
 *
 * KEY CONSIDERATIONS:
 *    • Converts "White Studio, Ltd." and "White Studio Group" both to "white studio".
 * ══════════════════════════════════════════════════════════════════════
 */
function extractBrandStem(name) {
  if (!name || typeof name !== 'string') return '';
  const cleaned = cleanPunctuationAndSpacing(name);
  const withoutSuffixes = stripLegalSuffixes(cleaned);
  return stripCorporateModifiers(withoutSuffixes);
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: compareBrandNames
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Compares two company names and determines whether they represent
 *    the same entity, a minor corporate suffix change, or a genuine rebrand.
 *
 * HOW IT WORKS:
 *    1. Normalizes empty/null inputs.
 *    2. If both are null, returns { match: true, classification: 'NOT_APPLICABLE' }.
 *    3. If one is null, returns { match: false, classification: 'NOT_FOUND_IN_CRAWL' | 'ADDED' }.
 *    4. If exact trimmed strings match, returns { match: true, classification: 'EXACT_MATCH' }.
 *    5. Extracts brand stems for both names via `extractBrandStem`.
 *    6. If brand stems match, returns { match: true, classification: 'STEM_MATCH' }.
 *    7. If stems differ, returns { match: false, classification: 'REBRAND' }.
 *
 * PARAMETERS:
 *    @param {string|null} oldName - Baseline company name
 *    @param {string|null} newName - Live crawl company name
 *
 * RETURNS:
 *    @returns {Object} { match: boolean, classification: string, stemOld: string, stemNew: string }
 *
 * KEY CONSIDERATIONS:
 *    • Accurately prevents legal restructuring ("Acme Ltd" -> "Acme LLC") from triggering rebrand alerts.
 * ══════════════════════════════════════════════════════════════════════
 */
function compareBrandNames(oldName, newName) {
  const hasOld = oldName !== null && oldName !== undefined && String(oldName).trim() !== '';
  const hasNew = newName !== null && newName !== undefined && String(newName).trim() !== '';

  if (!hasOld && !hasNew) {
    return { match: true, classification: 'NOT_APPLICABLE', stemOld: '', stemNew: '' };
  }

  if (hasOld && !hasNew) {
    return {
      match: false,
      classification: 'NOT_FOUND_IN_CRAWL',
      stemOld: extractBrandStem(oldName),
      stemNew: '',
    };
  }

  if (!hasOld && hasNew) {
    return {
      match: false,
      classification: 'ADDED',
      stemOld: '',
      stemNew: extractBrandStem(newName),
    };
  }

  const strOld = String(oldName).trim();
  const strNew = String(newName).trim();

  if (strOld.toLowerCase() === strNew.toLowerCase()) {
    return { match: true, classification: 'EXACT_MATCH', stemOld: strOld, stemNew: strNew };
  }

  const stemOld = extractBrandStem(strOld);
  const stemNew = extractBrandStem(strNew);

  if (stemOld && stemNew && stemOld === stemNew) {
    return { match: true, classification: 'STEM_MATCH', stemOld, stemNew };
  }

  return { match: false, classification: 'REBRAND', stemOld, stemNew };
}

module.exports = {
  LEGAL_SUFFIXES,
  CORPORATE_MODIFIERS,
  cleanPunctuationAndSpacing,
  stripLegalSuffixes,
  stripCorporateModifiers,
  extractBrandStem,
  compareBrandNames,
};

