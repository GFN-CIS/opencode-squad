#!/usr/bin/env node
// Measure each provider's prompt-cache TTL from opencode's own message history.
//
// Usage:
//   node squad-measure-cache-ttl.mjs [--db <file>] [--models] [--json]
//
// Reads the assistant messages opencode already stores (OpenCode 2's
// session_v2/session_message tables, or OpenCode 1's session/message on an
// older database), pairs consecutive ones
// on the same provider+model, and correlates the gap between them against
// whether the later one hit the prefix cache. See src/cache-ttl-measure.js for
// the method and why it's trustworthy (it reproduces Anthropic's published
// 300s from ~70k samples).
//
// MANUAL ONLY, like squad-file-performance.mjs: opencode never runs this. That
// staleness is tolerable here in a way it wasn't for the cache-status read path
// — this is a periodic measurement, and a provider with no entry falls back to
// the tiers in src/cache-status.js rather than to "unknown".
//
// Prints a report; writes nothing. Numbers worth keeping go into
// MEASURED_CACHE_TTL_SECONDS (src/cache-status.js) for a whole provider, or
// into model_data.json's `cache_ttl_seconds` for one specific model.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import {
  bucketize,
  collectSamples,
  deriveTtl,
  formatProviderReport,
} from "../src/cache-ttl-measure.js";
import { opencodeDataDir } from "../src/paths.js";

/**
 * @param {string[]} argv
 * @returns {{db: string, perModel: boolean, asJson: boolean}}
 */
function readArgs(argv) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        db: { type: "string" },
        models: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    return {
      db: values.db ?? path.join(opencodeDataDir(process.env, os.homedir()), "opencode.db"),
      perModel: values.models,
      asJson: values.json,
    };
  } catch (e) {
    console.error(
      `${e.message}\nUsage: squad-measure-cache-ttl.mjs [--db <file>] [--models] [--json]`,
    );
    process.exit(2);
  }
}

// The two storage layouts this script understands. OpenCode 2 migrates the
// OpenCode 1 history into its own tables and keeps the old ones, so where both
// exist only the OpenCode 2 tables are read — reading both would count every
// migrated session twice.
//
// OpenCode 2 (`session_message`): one row per entry, `type` beside `data`.
// An assistant turn's data holds `model: {id, providerID}`, `time.created`
// and `tokens: {input, output, reasoning, cache: {read, write}}` with no
// `total`. A context compaction is its own `compaction` entry, read as the
// summary turn OpenCode 1 stored inline.
const STORAGE = [
  {
    name: "OpenCode 2",
    tables: ["session_v2", "session_message"],
    sessions: "select id from session_v2",
    messages:
      "select type, data from session_message where session_id = ? and type in ('assistant', 'compaction') order by seq",
    /** @param {{type: string}} row @param {any} m */
    shape: (row, m) => ({
      providerID: m.model?.providerID,
      modelID: m.model?.id,
      summary: row.type === "compaction",
    }),
  },
  {
    name: "OpenCode 1",
    tables: ["session", "message"],
    sessions: "select id from session",
    messages:
      "select 'assistant' as type, data from message where session_id = ? and json_extract(data,'$.role') = 'assistant' order by time_created",
    /** @param {{type: string}} _row @param {any} m */
    shape: (_row, m) => ({
      providerID: m.providerID,
      modelID: m.modelID,
      summary: Boolean(m.summary),
    }),
  },
];

/**
 * The prompt a turn was sent with: the stored total, or the sum of its parts
 * where none is stored (OpenCode 2).
 *
 * @param {any} tokens
 */
function totalTokens(tokens) {
  if (typeof tokens?.total === "number") return tokens.total;
  const cache = tokens?.cache ?? {};
  return [tokens?.input, tokens?.output, tokens?.reasoning, cache.read, cache.write]
    .map((n) => (typeof n === "number" ? n : 0))
    .reduce((a, b) => a + b, 0);
}

/**
 * Pull every session's assistant messages, shaped for collectSamples().
 *
 * @param {string} dbFile
 * @returns {{storage: string, samples: ReturnType<typeof collectSamples>} | {error: string}}
 */
function readSamples(dbFile) {
  // Read-only: opencode may well be running against this same file.
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const tables = new Set(
      db
        .prepare("select name from sqlite_master where type = 'table'")
        .all()
        .map((r) => String(r.name)),
    );
    const layout = STORAGE.find((s) => s.tables.every((t) => tables.has(t)));
    if (!layout) {
      return {
        error:
          `Unsupported opencode storage in ${dbFile}: expected the OpenCode 2 tables ` +
          "(session_v2, session_message) or the OpenCode 1 tables (session, message).",
      };
    }
    const stmt = db.prepare(layout.messages);
    const samples = [];
    for (const { id } of db.prepare(layout.sessions).all()) {
      const messages = [];
      for (const row of stmt.all(id)) {
        let m;
        try {
          m = JSON.parse(String(row.data));
        } catch {
          continue; // a single unparseable row must not abort the sweep
        }
        messages.push({
          time: m.time?.created ?? 0,
          total: totalTokens(m.tokens),
          cacheRead: m.tokens?.cache?.read ?? 0,
          .../** @type {any} */ (layout.shape)(row, m),
        });
      }
      samples.push(...collectSamples(messages, String(id)));
    }
    return { storage: layout.name, samples };
  } finally {
    db.close();
  }
}

function main() {
  const { db, perModel, asJson } = readArgs(process.argv.slice(2));
  if (!fs.existsSync(db)) {
    console.error(`No opencode database at ${db}. Pass --db <file>.`);
    process.exit(1);
  }

  const read = readSamples(db);
  if ("error" in read) {
    console.error(read.error);
    process.exit(1);
  }
  const { storage, samples } = read;
  if (samples.length === 0) {
    console.error("No usable samples: every message pair was filtered out. Nothing to report.");
    process.exit(1);
  }

  const byProvider = [...Map.groupBy(samples, (s) => s.providerID)].sort(
    (a, b) => b[1].length - a[1].length,
  );
  const verdicts = {};
  const reports = [];
  for (const [providerID, rows] of byProvider) {
    const buckets = bucketize(rows);
    const verdict = deriveTtl(buckets);
    verdicts[providerID] = verdict;
    reports.push(formatProviderReport(providerID, buckets, verdict));
  }

  if (asJson) {
    console.log(
      JSON.stringify({ db, storage, samples: samples.length, providers: verdicts }, null, 2),
    );
    return;
  }

  console.log(`Database: ${db} (${storage} storage)`);
  console.log(
    `Usable samples: ${samples.length} across ${new Set(samples.map((s) => s.sessionID)).size} sessions\n`,
  );
  console.log(reports.join("\n\n"));

  if (perModel) {
    console.log("\n\n--- per model (only where there is enough to bucket) ---\n");
    const byModel = [...Map.groupBy(samples, (s) => `${s.providerID}/${s.modelID}`)].sort(
      (a, b) => b[1].length - a[1].length,
    );
    for (const [id, rows] of byModel) {
      if (rows.length < 50) continue;
      const buckets = bucketize(rows);
      console.log(`${formatProviderReport(id, buckets, deriveTtl(buckets))}\n`);
    }
  }

  console.log(
    "\nA verdict marked [weak] rests on a thin decisive bucket — treat it as a " +
      "direction, not a number. Nothing was written: copy values you trust into " +
      "MEASURED_CACHE_TTL_SECONDS (src/cache-status.js) for a provider, or into " +
      "model_data.json's `cache_ttl_seconds` for one model.",
  );
}

main();
