# Company Verification & Change Detection Methodology

A deterministic, multi-source framework for detecting entity changes, missing crawl data, and brand drift between historical baseline records and live web crawls.

---

## 1. Dual-Layer Verification Architecture

```
[Old Baseline JSON]  vs  [Fresh Live Crawl JSON]
            │                       │
    ┌───────┴───────────────────────┴───────┐
    ▼                                       ▼
Layer 1: Independent Field Scorer      Layer 2: Corroborated Deep Comparator
(field-scorer.js)                       (corroborator.js & brand-comparator.js)
- Evaluates field directly              - Cross-checks multi-source signals
- Detects presence vs absence           - Brand stem extraction & legal stripping
- Direct scoring (10 pts for missing)   - Fallback hierarchy (title, copyright)
    └───────┬───────────────────────┬───────┘
            ▼                       ▼
    [Unification Bridge: unifyFieldEvaluations()]
            │
            ▼
    Unified Output: Status = NOT_FOUND_IN_CRAWL | EXTRACTION_GAP | MODIFIED | UNCHANGED
```

---

## 2. Core State Matrix

When comparing any field between an Old Baseline and a New Live Crawl, the engine categorizes the change into deterministic states:

| Old Value | New Value | Status | Action / Meaning |
| :--- | :--- | :--- | :--- |
| **Populated** | **`null` / Empty** | `NOT_FOUND_IN_CRAWL` | Data dropped out or crawl failed to extract primary tag. |
| **Populated** | **`null` / Empty (Fallback matches)** | `EXTRACTION_GAP` | Primary tag missing, but title/copyright confirms company still exists. |
| **`null` / Empty** | **Populated** | `ADDED` | New field discovered in live crawl. |
| **Populated** | **Populated (Matches / Stem Match)** | `UNCHANGED` | Validated identical (after legal suffix & punctuation normalization). |
| **Populated** | **Populated (Differs)** | `MODIFIED` / `REBRAND` | Value changed to a different entity. |
| **`null` / Empty** | **`null` / Empty** | `NOT_APPLICABLE` | Field absent in both snapshots. |

---

## 3. Algorithms & Implementations

### Algorithm 1: Brand Stem Normalization (`brand-comparator.js`)
Raw company names often contain corporate suffixes (`Ltd`, `LLC`, `Pvt Ltd`, `GmbH`) or generic business modifiers (`Technologies`, `Group`, `Holdings`). Directly comparing strings causes false positives.

1. **Lowercase & strip punctuation**: `"White Studio, Ltd."` -> `"white studio ltd"`.
2. **Strip legal suffixes** using right-anchored word boundaries:
   `['ltd', 'limited', 'inc', 'corp', 'llc', 'gmbh', 'plc', 'pvt ltd', 'co']`
3. **Strip corporate modifiers**:
   `['group', 'technologies', 'holdings', 'ventures', 'solutions', 'services']`
4. **Resulting Stem**: `"white studio"`.

```javascript
const { extractBrandStem, compareBrandNames } = require('./brand-comparator');

const result = compareBrandNames('White Studio Ltd', 'White Studio Group');
// result.match -> true
// result.classification -> 'STEM_MATCH'
```

---

### Algorithm 2: Multi-Source Hierarchy & Fallback (`corroborator.js`)
If `companyName` is null in the live crawl, the engine checks candidate fallback sources in order of trust:
1. **Primary:** `companyName` / `name` (meta tags & schema.org JSON-LD).
2. **Secondary:** `nameFromCopyright` (extracted from `© 2024 [Name]`).
3. **Tertiary:** `nameFromTitle` (extracted from `<title>` tag before delimiters like `|` or `-`).

#### Resolution Rule:
* If the baseline had `"White Studio"`, but primary meta tag returns `null` while `<title>` contains `"White Studio Bridal"`, classify as `EXTRACTION_GAP` rather than a genuine company shutdown or rebrand.
* If all sources are `null`, classify as `NOT_FOUND_IN_CRAWL`.

```javascript
const { corroborateCompanyName } = require('./corroborator');

const check = corroborateCompanyName('White Studio', {
  companyName: null,
  title: 'White Studio Bridal | Home',
});
// check.isExtractionGap -> true
// check.status -> 'EXTRACTION_GAP'
// check.tier -> 'tertiary'
```

---

### Algorithm 3: Semantic Content Filtering & Token Jaccard (`content-comparator.js`)
For descriptions, homepage text, about pages, and terms content, simple string equality triggers false positives over minor grammatical filler edits (e.g. *"there was an office"* -> *"there is an office"* or adding *"the"* / *"in"*).

#### 3-Stage Content Pipeline:
1. **HTML & Entity Stripping:** Strips `<script>`, `<style>`, HTML tags, and entities (`&amp;`, `&#39;`).
2. **Stop-Word Removal:** Filters out high-frequency grammatical fillers:
   `the`, `is`, `in`, `not`, `there`, `was`, `were`, `a`, `an`, `and`, `or`, `of`, `for`, `with`, `on`, `at`, `by`, `from`, `to`, `as`, `it`, `this`, `that`, `be`, `are`, `been`, `has`, `have`, `had`, etc.
3. **Token Jaccard Calculation:**
   $$\text{Jaccard}(A, B) = \frac{|A \cap B|}{|A \cup B|}$$

#### Thresholds:
* **Similarity >= 0.85:** `UNCHANGED`. Difference consists only of filler words or cosmetic formatting. Suppressed from change logs.
* **Similarity < 0.85:** `MODIFIED`. Substantive textual shift detected.

```javascript
const { compareContent } = require('./content-comparator');

const oldText = "There was an office located in the city center.";
const newText = "There is an office located in a city center.";

const result = compareContent(oldText, newText);
// result.hasChanged -> false
// result.status -> 'UNCHANGED'
// result.similarity -> 1.0 (after filtering 'there', 'was', 'is', 'an', 'in', 'the', 'a')
```

---

## 4. API Reference

### `compareEntities(oldRecord, newRecord, rawCrawlData, options)`
Executes full dual-layer evaluation across all profile and content fields:

```javascript
const { compareEntities } = require('./index');

const evaluation = compareEntities(
  {
    company_name: 'White Studio Ltd',
    phone: '+44 20 7946 0991',
    content: 'Old website content...',
  },
  {
    company_name: null,
    phone: '+44 20 7946 0999',
    content: 'Old website content with the extra words...',
  },
  {
    title: 'White Studio | Official Site',
  }
);

console.log(evaluation.diff);
// company_name -> status: 'EXTRACTION_GAP' (corroborated via title)
// phone        -> status: 'MODIFIED' (new phone number)
// content      -> status: 'UNCHANGED' (stop-word changes suppressed)
```

### `detectMissingFieldsOnly(oldRecord, newRecord, targetFields)`
Filters strictly for records where baseline data was lost or unextracted in the live crawl:

```javascript
const { detectMissingFieldsOnly } = require('./index');

const missing = detectMissingFieldsOnly(oldRow, newRow, ['company_name', 'phone', 'email']);
if (missing.has_missing) {
  console.log('Fields unextracted in crawl:', missing.missing_fields);
}
```

