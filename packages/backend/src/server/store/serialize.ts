// ---------------------------------------------------------------------------
// (De)serialization boundary helpers.
//
// Dates serialize to ISO strings for free (Date.prototype.toJSON), so writing
// needs nothing. Reading must turn the listed top-level timestamp fields back
// into `Date` objects to match the old Drizzle row shape. We revive ONLY the
// declared keys — never deep-walk — so ISO-looking strings inside opaque JSON
// blobs (payload, metadata, data, conversationState, outputContract) stay
// untouched, exactly as Postgres jsonb returned them.
// ---------------------------------------------------------------------------

/** Revive the named top-level keys of a row from ISO string → Date, in place. */
export function reviveDates<T extends Record<string, unknown>>(
  row: T,
  dateKeys: readonly string[],
): T {
  for (const key of dateKeys) {
    const v = row[key];
    if (typeof v === "string") {
      (row as Record<string, unknown>)[key] = new Date(v);
    }
  }
  return row;
}

/** Revive a list of rows. */
export function reviveDatesAll<T extends Record<string, unknown>>(
  rows: T[],
  dateKeys: readonly string[],
): T[] {
  for (const row of rows) reviveDates(row, dateKeys);
  return rows;
}
