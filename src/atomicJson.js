// ─── Atomic JSON persistence ──────────────────────────────────────────────────
//
// Raw fs.writeFileSync writes in place, so a crash or power cut mid-write can
// leave a truncated, half-written JSON file and corrupt your ledger.
// `write-file-atomic` writes to a temp file, fsyncs it, then renames it over
// the target (atomic on the same filesystem). A reader only ever sees the old
// complete file or the new complete file, never a partial one.

import writeFileAtomic from 'write-file-atomic';
import { readFileSync, existsSync } from 'fs';

/** Synchronous atomic write of a JS value as JSON. */
export function writeJsonAtomic(filePath, data, { pretty = true } = {}) {
  const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  writeFileAtomic.sync(filePath, json);
}

/** Reader that never throws: returns `fallback` on missing/corrupt files. */
export function readJsonSafe(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}
