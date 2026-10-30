/**
 * ──────────────────────────────────────────────────────────────────
 * Worker 3: DB Diff & Micro-Batch Flusher
 * ──────────────────────────────────────────────────────────────────
 * Pulls cleaned data from `db_queue`, fetches old records from both
 * `company_profile_global` and `domain_content_staging` (projection pruning),
 * computes in-memory diffs on both profile metadata and page contents, and
 * buffers records for micro-batch upsert.
 *
 * Updates both target tables:
 *   1. public.company_profile_global (core metadata + change_logs diff)
 *   2. public.domain_content_staging (scraped content & subpages)
 *
 * Key design:
 * • Concurrency: 15 (env-configurable)
 * • Micro-batching: Flushes every 1s OR at 50 records (whichever first)
 * • Deterministic deadlock elimination: sorts batch by domain
 * • Dual-table projection pruning: never SELECT * — only needed columns
 * • In-memory diffing across 33 profile fields + 5 content staging fields
 * • Dual-table atomic upsert in a single transaction
 * • Toggleable via ENABLE_DB_WRITES in .env (defaults to true)
 */

const { Worker } = require('bullmq');
const { redisConnection } = require('../config/redis.config');
const { dbPool, pingDb } = require('../config/db.config');
const env = require('../config/env.config');
const logger = require('../utils/logger');

let dbWorker = null;
let flushTimer = null;

// ─── Micro-Batch Write Buffer ────────────────────────────────────
const writeBuffer = [];

/**
 * ══════════════════════════════════════════════════════════════════════
 * HELPER: sanitizeIp
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Validates whether a string is a valid IPv4 or IPv6 address for the
 *    PostgreSQL inet data type, returning null if invalid.
 *
 * HOW IT WORKS:
 *    1. Returns null if ip is falsy or not a string.
 *    2. Trims leading and trailing whitespace.
 *    3. Tests against IPv4 regex (^(\d{1,3}\.){3}\d{1,3}$).
 *    4. Tests against IPv6 format (hex chars with colons).
 *    5. Returns trimmed valid IP string, or null if validation fails.
 *
 * PARAMETERS:
 *    @param {string|null} ip - Host IP address string from crawler
 *
 * RETURNS:
 *    @returns {string|null} Validated IP string or null
 *
 * KEY CONSIDERATIONS:
 *    • Prevents PostgreSQL query crashes when inserting into inet columns.
 * ══════════════════════════════════════════════════════════════════════
 */
function sanitizeIp(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6Regex = /^[0-9a-fA-F:]+$/;
  if (ipv4Regex.test(trimmed) || (trimmed.includes(':') && ipv6Regex.test(trimmed))) {
    return trimmed;
  }
  return null;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * HELPER: truncateStr
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Truncates strings that exceed column character limits in PostgreSQL
 *    schema definitions (e.g. varchar(500), varchar(100)).
 *
 * HOW IT WORKS:
 *    1. Returns null if input value is null or undefined.
 *    2. Converts value to string and trims whitespace.
 *    3. If empty string, returns null.
 *    4. If string length > maxLen, returns substring of length maxLen.
 *    5. Otherwise returns trimmed string.
 *
 * PARAMETERS:
 *    @param {any} val - Value to truncate
 *    @param {number} maxLen - Maximum allowed character length
 *
 * RETURNS:
 *    @returns {string|null} Truncated string or null
 *
 * KEY CONSIDERATIONS:
 *    • Prevents PostgreSQL "value too long for type character varying" fatal errors.
 * ══════════════════════════════════════════════════════════════════════
 */
function truncateStr(val, maxLen) {
  if (val === null || val === undefined) return null;
  const str = String(val).trim();
  if (!str) return null;
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: flushBatchToPostgres
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Flushes accumulated domain records from `writeBuffer` to PostgreSQL
 *    in a single atomic micro-batch, updating both target tables:
 *      1. `public.company_profile_global` (company profile metadata + diff)
 *      2. `public.domain_content_staging` (raw HTML / text page contents)
 *
 * HOW IT WORKS:
 *    1. Returns immediately if `writeBuffer` is empty.
 *    2. Atomically splices all items out of `writeBuffer`.
 *    3. Sorts records alphabetically by `domain` (Deterministic Deadlock Elimination)
 *       so row locks in PostgreSQL are always acquired in identical order across connections.
 *    4. If `env.dbWorker.enableDbWrites` is false, logs dry-run output and returns.
 *    5. Opens a PostgreSQL client connection and begins transaction (`BEGIN`).
 *    6. For each item in batch:
 *       a. Upserts into `company_profile_global` with all 33 crawler fields.
 *          Appends change log entry if in-memory diff detected modifications.
 *       b. Retrieves `src_id` / `id` from `company_profile_global`.
 *       c. Upserts into `domain_content_staging` with all 5 content fields
 *          (content, about_content, contact_content, privacy_content, terms_content).
 *    7. Commits transaction (`COMMIT`) and releases connection to pool.
 *
 * PARAMETERS:
 *    None (operates on module-level `writeBuffer`).
 *
 * RETURNS:
 *    @returns {Promise<void>}
 *
 * KEY CONSIDERATIONS:
 *    • Single atomic transaction per batch ensures zero orphan records between tables.
 *    • Micro-batching cuts disk IOPS from ~15-20 individual writes/sec down to 1 batch commit/sec.
 * ══════════════════════════════════════════════════════════════════════
 */
async function flushBatchToPostgres() {
  if (writeBuffer.length === 0) return;

  // Atomically splice the buffer
  const batch = writeBuffer.splice(0, writeBuffer.length);

  // ─── Deterministic Deadlock Elimination ──────────────────
  batch.sort((a, b) => a.domain.localeCompare(b.domain));

  logger.info(
    { batchSize: batch.length, domains: batch.map((b) => b.domain).slice(0, 5) },
    'Flushing micro-batch to DB'
  );

  if (!env.dbWorker.enableDbWrites) {
    logger.info(
      { batchSize: batch.length },
      '[DRY RUN] Both tables (company_profile_global & domain_content_staging) prepared for batch write (writes disabled via ENABLE_DB_WRITES=false)'
    );
    return;
  }

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    for (const item of batch) {
      const p = item.profile;
      const s = item.staging;

      // Prepare change log entry
      const changeEntry = item.hasChanges
        ? JSON.stringify({
            last_updated: new Date().toISOString(),
            diff: item.diff,
          })
        : null;

      // ─── 1. Upsert into public.company_profile_global ────────
      const profileRes = await client.query(`
        INSERT INTO company_profile_global (
          domain_name,
          normalized_domain,
          company_name,
          website,
          logo,
          title,
          description,
          "language",
          country,
          phone,
          email,
          about_link,
          contact_link,
          privacy_link,
          terms_link,
          home_alllinks,
          about_alllinks,
          contact_alllinks,
          privacy_alllinks,
          terms_alllinks,
          response_code,
          load_time_ms,
          host_ip,
          web_server,
          linkedin_url,
          facebook_url,
          twitter_url,
          instagram_url,
          youtube_url,
          github_url,
          medium_url,
          tiktok_url,
          context_extract_status,
          change_logs,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20,
          $21, $22, $23, $24,
          $25, $26, $27, $28, $29,
          $30, $31, $32, $33,
          COALESCE($34::jsonb, '[]'::jsonb), NOW()
        )
        ON CONFLICT (domain_name) DO UPDATE SET
          normalized_domain      = EXCLUDED.normalized_domain,
          company_name           = EXCLUDED.company_name,
          website                = EXCLUDED.website,
          logo                   = EXCLUDED.logo,
          title                  = EXCLUDED.title,
          description            = EXCLUDED.description,
          "language"             = EXCLUDED."language",
          country                = EXCLUDED.country,
          phone                  = EXCLUDED.phone,
          email                  = EXCLUDED.email,
          about_link             = EXCLUDED.about_link,
          contact_link           = EXCLUDED.contact_link,
          privacy_link           = EXCLUDED.privacy_link,
          terms_link             = EXCLUDED.terms_link,
          home_alllinks          = EXCLUDED.home_alllinks,
          about_alllinks         = EXCLUDED.about_alllinks,
          contact_alllinks       = EXCLUDED.contact_alllinks,
          privacy_alllinks       = EXCLUDED.privacy_alllinks,
          terms_alllinks         = EXCLUDED.terms_alllinks,
          response_code          = EXCLUDED.response_code,
          load_time_ms           = EXCLUDED.load_time_ms,
          host_ip                = EXCLUDED.host_ip,
          web_server             = EXCLUDED.web_server,
          linkedin_url           = EXCLUDED.linkedin_url,
          facebook_url           = EXCLUDED.facebook_url,
          twitter_url            = EXCLUDED.twitter_url,
          instagram_url          = EXCLUDED.instagram_url,
          youtube_url            = EXCLUDED.youtube_url,
          github_url             = EXCLUDED.github_url,
          medium_url             = EXCLUDED.medium_url,
          tiktok_url             = EXCLUDED.tiktok_url,
          context_extract_status = EXCLUDED.context_extract_status,
          change_logs            = CASE
            WHEN $35 = true AND $36 IS NOT NULL THEN
              jsonb_insert(COALESCE(company_profile_global.change_logs, '[]'::jsonb), '{0}', $36::jsonb, true)
            ELSE company_profile_global.change_logs
          END,
          updated_at             = NOW()
        RETURNING id, src_id;
      `, [
        truncateStr(p.domain_name, 500),
        truncateStr(p.normalized_domain, 500),
        truncateStr(p.company_name, 500),
        p.website,
        p.logo,
        p.title,
        p.description,
        truncateStr(p.language, 100),
        truncateStr(p.country, 100),
        truncateStr(p.phone, 100),
        truncateStr(p.email, 100),
        p.about_link,
        p.contact_link,
        p.privacy_link,
        p.terms_link,
        p.home_alllinks,
        p.about_alllinks,
        p.contact_alllinks,
        p.privacy_alllinks,
        p.terms_alllinks,
        p.response_code,
        p.load_time_ms,
        sanitizeIp(p.host_ip),
        truncateStr(p.web_server, 100),
        p.linkedin_url,
        p.facebook_url,
        p.twitter_url,
        p.instagram_url,
        p.youtube_url,
        p.github_url,
        p.medium_url,
        p.tiktok_url,
        truncateStr(p.context_extract_status, 500),
        changeEntry ? JSON.stringify([JSON.parse(changeEntry)]) : '[]',
        item.hasChanges,
        changeEntry,
      ]);

      const insertedRow = profileRes.rows[0];
      const resolvedSrcId = item.srcId || insertedRow?.src_id || insertedRow?.id || null;

      // ─── 2. Upsert into public.domain_content_staging ────────
      await client.query(`
        INSERT INTO domain_content_staging (
          domain_name,
          "content",
          about_content,
          contact_content,
          privacy_content,
          terms_content,
          src_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (domain_name) DO UPDATE SET
          "content"       = EXCLUDED."content",
          about_content   = EXCLUDED.about_content,
          contact_content = EXCLUDED.contact_content,
          privacy_content = EXCLUDED.privacy_content,
          terms_content   = EXCLUDED.terms_content,
          src_id          = COALESCE(EXCLUDED.src_id, domain_content_staging.src_id);
      `, [
        truncateStr(s.domain_name, 600),
        s.content,
        s.about_content,
        s.contact_content,
        s.privacy_content,
        s.terms_content,
        resolvedSrcId,
      ]);
    }

    await client.query('COMMIT');
    logger.info({ batchSize: batch.length }, 'Successfully updated both tables in PostgreSQL');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err: err.message, batchSize: batch.length }, 'Failed to commit batch to PostgreSQL');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Tracked profile fields for detecting company_profile_global change logs.
 */
const TRACKED_PROFILE_FIELDS = [
  'company_name',
  'normalized_domain',
  'website',
  'logo',
  'title',
  'description',
  'language',
  'country',
  'phone',
  'email',
  'about_link',
  'contact_link',
  'privacy_link',
  'terms_link',
  'home_alllinks',
  'about_alllinks',
  'contact_alllinks',
  'privacy_alllinks',
  'terms_alllinks',
  'response_code',
  'load_time_ms',
  'host_ip',
  'web_server',
  'linkedin_url',
  'facebook_url',
  'twitter_url',
  'instagram_url',
  'youtube_url',
  'github_url',
  'medium_url',
  'tiktok_url',
  'context_extract_status',
];

/**
 * Tracked content staging fields for detecting domain_content_staging changes.
 */
const TRACKED_CONTENT_FIELDS = [
  'content',
  'about_content',
  'contact_content',
  'privacy_content',
  'terms_content',
];

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: buildFieldDiff
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Compares existing PostgreSQL record (`oldRow`) against newly extracted
 *    values (`newValues`) across a specified list of fields to compute
 *    field-level change diffs.
 *
 * HOW IT WORKS:
 *    1. If `oldRow` is missing (new domain), returns empty diff object.
 *    2. Iterates over all keys in `fieldsToTrack` (defaults to `TRACKED_PROFILE_FIELDS`).
 *    3. Skips any field where `newValue` is null or undefined.
 *    4. Normalizes string values by trimming leading/trailing whitespace.
 *    5. If normalized values differ, adds entry `{ old_data, new_data }`.
 *    6. Returns the completed diff map for storing in `change_logs`.
 *
 * PARAMETERS:
 *    @param {Object|null} oldRow - Existing record read from PostgreSQL
 *    @param {Object} newValues - Cleaned values returned from crawler/AI
 *    @param {string[]} [fieldsToTrack=TRACKED_PROFILE_FIELDS] - Array of field keys to diff
 *
 * RETURNS:
 *    @returns {Object} Object mapping changed field names to { old_data, new_data }
 *
 * KEY CONSIDERATIONS:
 *    • String trimming prevents false-positive diffs caused by formatting whitespace.
 *    • Null/undefined checks ensure unextracted fields do not overwrite valid existing data with false diffs.
 * ══════════════════════════════════════════════════════════════════════
 */
function buildFieldDiff(oldRow, newValues, fieldsToTrack = TRACKED_PROFILE_FIELDS) {
  const diff = {};
  if (!oldRow) {
    return diff;
  }

  for (const key of fieldsToTrack) {
    const newValue = newValues[key];
    if (newValue === null || newValue === undefined) continue;

    const oldValue = oldRow[key];

    // Normalize strings for comparison (trim whitespace)
    const normalizedOld =
      typeof oldValue === 'string'
        ? oldValue.trim()
        : oldValue === undefined || oldValue === null
          ? null
          : oldValue;

    const normalizedNew =
      typeof newValue === 'string' ? newValue.trim() : newValue;

    if (normalizedNew !== normalizedOld) {
      diff[key] = {
        old_data: normalizedOld,
        new_data: normalizedNew,
      };
    }
  }
  return diff;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: buildContentDiff
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Compares existing content stored in `domain_content_staging` (`oldRow`)
 *    against newly scraped page contents (`newValues`) across all 5 tracked
 *    content fields: `content`, `about_content`, `contact_content`,
 *    `privacy_content`, and `terms_content`.
 *
 * HOW IT WORKS:
 *    1. If `oldRow` is missing (domain not yet staged), returns an empty diff object.
 *    2. Delegates comparison to `buildFieldDiff` with `TRACKED_CONTENT_FIELDS`.
 *    3. Skips any field where `newValues[key]` is null or undefined.
 *    4. Normalizes string values by trimming leading and trailing whitespace.
 *    5. Checks if `normalizedNew !== normalizedOld`.
 *    6. If modified, records `{ old_data: normalizedOld, new_data: normalizedNew }`.
 *    7. Returns the diff object mapping modified content field names to their old/new values.
 *
 * PARAMETERS:
 *    @param {Object|null} oldRow - Existing record read from `domain_content_staging`
 *    @param {Object} newValues - Cleaned staging content object
 *
 * RETURNS:
 *    @returns {Object} Object mapping changed content fields to { old_data, new_data }
 *
 * KEY CONSIDERATIONS:
 *    • Uses the exact comparison and normalization pattern as `buildFieldDiff`.
 *    • Detects modifications in homepage, about, contact, privacy, and terms text bodies.
 *    • Integrates into `change_logs` to preserve a comprehensive audit trail of content changes.
 * ══════════════════════════════════════════════════════════════════════
 */
function buildContentDiff(oldRow, newValues) {
  return buildFieldDiff(oldRow, newValues, TRACKED_CONTENT_FIELDS);
}

// Alias for backwards compatibility
const calculateDiff = buildFieldDiff;

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: startDBWorker
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Initializes and starts the BullMQ Worker for Stage 3 (`db_queue`).
 *    Handles DB diffing, latency backpressure, and micro-batch writes.
 *
 * HOW IT WORKS:
 *    1. Starts a background interval (`flushTimer`) to flush buffered writes every 1 second.
 *    2. Spawns BullMQ Worker with clamped concurrency (`env.dbWorker.concurrency`, default: 15).
 *    3. For every incoming job:
 *       a. Checks DB health (`pingDb`); pauses if PostgreSQL round-trip latency > 500ms.
 *       b. Reads existing records via projection pruning from both `company_profile_global`
 *          and `domain_content_staging` using a single indexed query.
 *       c. Separates cleaned input into `profileData` (metadata) and `stagingData` (content).
 *       d. Computes metadata diff (`buildFieldDiff`) and content diff (`buildContentDiff`).
 *       e. Detects if either profile or content changed (`hasChanges`).
 *       f. Appends merged item with combined diff to `writeBuffer`.
 *       g. If buffer hits batch size (default: 50), flushes immediately without waiting for interval.
 *    4. Attaches failure and error event listeners with structured Pino logging.
 *
 * PARAMETERS:
 *    None (reads configuration from `env.dbWorker` and `redisConnection`).
 *
 * RETURNS:
 *    @returns {Worker} Active BullMQ Worker instance
 *
 * KEY CONSIDERATIONS:
 *    • Concurrency is clamped at 15 to stay within the PostgreSQL connection pool limit.
 *    • Micro-batch buffer threshold (50 items) + 1-second interval ensures both high throughput and low write latency.
 * ══════════════════════════════════════════════════════════════════════
 */
function startDBWorker() {
  // ─── Periodic Flush Timer (every 1 second) ─────────────────
  flushTimer = setInterval(async () => {
    try {
      await flushBatchToPostgres();
    } catch (err) {
      logger.error({ err: err.message }, 'Periodic flush failed');
    }
  }, env.dbWorker.flushIntervalMs);

  dbWorker = new Worker(
    'db_queue',
    async (job) => {
      const { domain, cleanedData, crawledAt } = job.data;

      if (!domain || !cleanedData) {
        logger.warn({ jobId: job.id }, 'Skipping DB job with missing data');
        return;
      }

      // ─── Latency Backpressure ──────────────────────────────
      const latency = await pingDb();
      if (latency > 500) {
        logger.warn(
          { latency },
          'DB latency high, pausing DB worker briefly'
        );
        await new Promise((r) => setTimeout(r, 3000));
      } else if (latency === -1 && env.dbWorker.enableDbWrites) {
        logger.error('DB unreachable — pausing for 5s');
        await new Promise((r) => setTimeout(r, 5000));
      }

      // ─── Step 3: Fetch Old Records (Projection Pruning) ───
      let oldData = null;
      let oldContent = null;
      if (env.dbWorker.enableDbWrites) {
        try {
          const { rows } = await dbPool.query(
            `SELECT
               p.id, p.src_id, p.domain_name, p.normalized_domain, p.company_name, p.website, p.logo, p.title, p.description,
               p."language", p.country, p.phone, p.email, p.about_link, p.contact_link, p.privacy_link, p.terms_link,
               p.home_alllinks, p.about_alllinks, p.contact_alllinks, p.privacy_alllinks, p.terms_alllinks,
               p.response_code, p.load_time_ms, p.host_ip, p.web_server,
               p.linkedin_url, p.facebook_url, p.twitter_url, p.instagram_url, p.youtube_url,
               p.github_url, p.medium_url, p.tiktok_url, p.context_extract_status,
               p.change_logs,
               c.domain_name AS staging_domain_name,
               c."content" AS staging_content,
               c.about_content AS staging_about_content,
               c.contact_content AS staging_contact_content,
               c.privacy_content AS staging_privacy_content,
               c.terms_content AS staging_terms_content
             FROM (SELECT $1::varchar AS d_name) d
             LEFT JOIN company_profile_global p ON p.domain_name = d.d_name
             LEFT JOIN domain_content_staging c ON c.domain_name = d.d_name`,
            [domain]
          );

          const row = rows[0];
          if (row && row.domain_name) {
            oldData = row;
          }
          if (row && row.staging_domain_name) {
            oldContent = {
              content:         row.staging_content,
              about_content:   row.staging_about_content,
              contact_content: row.staging_contact_content,
              privacy_content: row.staging_privacy_content,
              terms_content:   row.staging_terms_content,
            };
          }
        } catch (err) {
          logger.warn({ domain, err: err.message }, 'Could not read existing profile or content; proceeding as new record');
        }
      }

      // ─── Extract Profile and Staging Structures ────────────
      const profileData = cleanedData.profile || cleanedData;
      const stagingData = cleanedData.staging || {
        domain_name:     domain,
        content:         cleanedData.home_content || cleanedData.content || null,
        about_content:   cleanedData.about_content || null,
        contact_content: cleanedData.contact_content || null,
        privacy_content: cleanedData.privacy_content || null,
        terms_content:   cleanedData.terms_content || null,
      };

      // ─── Step 3b: Compute In-Memory Diffs ─────────────────
      const profileDiff = buildFieldDiff(oldData, profileData, TRACKED_PROFILE_FIELDS);
      const contentDiff = buildContentDiff(oldContent, stagingData);

      const hasProfileChanges = Object.keys(profileDiff).length > 0;
      const hasContentChanges = Object.keys(contentDiff).length > 0;
      const hasChanges = hasProfileChanges || hasContentChanges;

      // Combined diff object (profile metadata + page content) for change_logs
      const diff = {
        ...profileDiff,
        ...contentDiff,
      };

      // ─── Step 4: Add to Micro-Batch Buffer ─────────────────
      writeBuffer.push({
        domain,
        profile: profileData,
        staging: stagingData,
        diff,
        profileDiff,
        contentDiff,
        hasChanges,
        hasProfileChanges,
        hasContentChanges,
        isNewProfile: !oldData,
        isNewContent: !oldContent,
        srcId: oldData?.src_id || oldData?.id || null,
        crawledAt,
      });

      // Flush immediately if buffer reaches batch size
      if (writeBuffer.length >= env.dbWorker.batchSize) {
        await flushBatchToPostgres();
      }

      logger.debug(
        {
          domain,
          profileDiffCount: Object.keys(profileDiff).length,
          contentDiffCount: Object.keys(contentDiff).length,
          hasChanges,
          bufferSize: writeBuffer.length,
        },
        'Buffered for micro-batch'
      );
    },
    {
      connection: redisConnection,
      concurrency: env.dbWorker.concurrency,  // 15
    }
  );

  dbWorker.on('failed', (job, err) => {
    logger.error(
      { domain: job?.data?.domain, jobId: job?.id, err: err.message, attempt: job?.attemptsMade },
      'DB worker job failed'
    );
  });

  dbWorker.on('error', (err) => {
    logger.error({ err: err.message }, 'DB worker error');
  });

  logger.info(
    {
      concurrency: env.dbWorker.concurrency,
      batchSize: env.dbWorker.batchSize,
      flushIntervalMs: env.dbWorker.flushIntervalMs,
      enableDbWrites: env.dbWorker.enableDbWrites,
    },
    'DB diff worker started'
  );

  return dbWorker;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * FUNCTION: stopDBWorker
 * ══════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *    Safely shuts down the DB worker without data loss during SIGINT/SIGTERM.
 *
 * HOW IT WORKS:
 *    1. Clears `flushTimer` interval to halt scheduled ticks.
 *    2. Checks if any records remain unflushed in `writeBuffer`; if so, triggers
 *       a final `flushBatchToPostgres()` call to ensure zero in-memory data loss.
 *    3. Calls `dbWorker.close()` to wait for currently active jobs to finish and
 *       disconnect from Redis.
 *
 * PARAMETERS:
 *    None.
 *
 * RETURNS:
 *    @returns {Promise<void>}
 *
 * KEY CONSIDERATIONS:
 *    • Ensures buffer drains before process exit so no processed crawl jobs are lost.
 * ══════════════════════════════════════════════════════════════════════
 */
async function stopDBWorker() {
  // Stop the periodic flush timer
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  // Flush remaining buffer
  if (writeBuffer.length > 0) {
    logger.info({ remaining: writeBuffer.length }, 'Flushing remaining buffer before shutdown...');
    try {
      await flushBatchToPostgres();
    } catch (err) {
      logger.error({ err: err.message }, 'Final flush failed during shutdown');
    }
  }

  // Close the worker
  if (dbWorker) {
    logger.info('Stopping DB worker...');
    await dbWorker.close();
    logger.info('DB worker stopped.');
  }
}

module.exports = {
  startDBWorker,
  stopDBWorker,
  buildFieldDiff,
  buildContentDiff,
  calculateDiff,
  flushBatchToPostgres,
  TRACKED_PROFILE_FIELDS,
  TRACKED_CONTENT_FIELDS,
};

