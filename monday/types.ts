/**
 * monday/types.ts
 *
 * TypeScript interfaces for the Monday.com v2 GraphQL API responses
 * and the user-editable column mapping config.
 */

// ---------- Monday.com API shapes ----------

/** A single column's value on a board item. */
export interface MondayColumnValue {
  /** The column's internal Monday ID (e.g. "status", "text0", "date4") */
  id: string;
  /** The human-readable column title shown in the board UI */
  title: string;
  /**
   * Display-formatted value — almost always the right thing to read.
   * Monday normalizes this to a string regardless of column type.
   * Examples: "Acme Corp", "warm", "2026-05-20", "https://acme.com"
   */
  text: string;
  /**
   * Raw JSON string Monday stores internally. Useful for structured
   * types like dates ({ "date": "2026-05-20" }) or status indexes.
   * May be null if the column is empty.
   */
  value: string | null;
  /**
   * Column type string, e.g. "text", "status", "date", "email",
   * "link", "long_text", "people", "dropdown", "numeric".
   */
  type: string;
}

/** A single board item (i.e. one deal/row). */
export interface MondayItem {
  /** Monday's numeric item ID (as a string) */
  id: string;
  /** The item's display name — typically the company or deal name */
  name: string;
  board: {
    id: string;
    name: string;
  };
  /**
   * The Monday user who created this item.
   * Used as an AE attribution fallback when no Primary column match is found.
   */
  creator?: {
    id: string;
    name: string;
    email: string;
  };
  column_values: MondayColumnValue[];
}

/** A full board, including its schema (columns) and all items. */
export interface MondayBoard {
  id: string;
  name: string;
  /** The board's column schema — useful for introspection/debugging */
  columns: {
    id: string;
    title: string;
    type: string;
  }[];
  items_page: {
    items: MondayItem[];
  };
}

// ---------- Column mapping config (monday/mapping.json) ----------

/**
 * The shape of monday/mapping.json — a user-editable file that tells
 * the mapper exactly which Monday column title maps to which Lead field.
 *
 * Any field omitted here falls back to keyword auto-detection.
 * Column titles are matched case-insensitively.
 */
export interface ColumnMapping {
  /**
   * Optional: lock this mapping to a specific board ID.
   * The runner will warn if the fetched board ID doesn't match.
   */
  boardId?: string;

  /**
   * Map of Lead field name → the Monday column title for your board.
   *
   * Supported Lead field keys:
   *   company, website, prospectName, prospectTitle,
   *   aeName, aeEmail, meetingAt, dealStage, productFocus,
   *   hypothesis, callObjective, meetingContext,
   *   prospectArchetype, meetingType, engagementShape,
   *   introSource, introContext, audience,
   *   competitiveContext, excludeKeywords
   */
  columnMap: Partial<Record<string, string>>;

  /**
   * Hardcoded fallback values applied AFTER column mapping AND AE resolution.
   * Only fills fields not already set by column mapping or AE attribution.
   *
   * Example:
   *   "defaults": { "aeEmail": "spenser@arvayaconsulting.com", "aeName": "Spenser" }
   */
  defaults?: Partial<Record<string, unknown>>;

  /**
   * Lookup table mapping Monday "Primary" (people column) display names → email addresses.
   * Used for AE attribution: the mapper reads the Primary column's text, finds the first
   * person, and resolves their email via this table.
   *
   * Keys should match what Monday returns as the people column text (first + last name).
   * Matching is case-insensitive and falls back to partial matching.
   *
   * Example:
   *   "teamEmails": {
   *     "Spenser Chun": "spenserchun@arvayaconsulting.com",
   *     "Jane Doe": "jane@arvayaconsulting.com"
   *   }
   */
  teamEmails?: Record<string, string>;

  /**
   * Column titles to silently ignore — consumed so they don't appear in
   * `unmappedColumns` or get sent to the AI synthesizer, but never mapped
   * to any Lead field. Matched case-insensitively.
   *
   * Use for Monday system/noise columns that will never contribute Lead data.
   * Employee headcount is intentionally excluded here — the Researcher finds
   * current figures independently via Perplexity/LinkedIn during the prep run.
   *
   * Example:
   *   "skipColumns": ["# of Employees", "Company Size (LinkedIn)", "Box"]
   */
  skipColumns?: string[];
}

// ---------- Mapper output ----------

/** What the mapper returns before Zod validation. */
export interface MappedLead {
  /** The partial Lead object extracted from column values */
  fields: Record<string, unknown>;
  /**
   * Columns that were consumed (matched to a Lead field OR explicitly skipped).
   * The synthesizer skips these so it doesn't double-process them.
   */
  consumedColumnTitles: Set<string>;
  /**
   * Maps each consumed column title → the Lead field it was actually
   * mapped to. Used by describeMappingResult for accurate reporting.
   * Skipped columns are NOT present in this map.
   */
  columnFieldMap: Map<string, string>;
  /**
   * Column titles that were silently skipped (matched a skip rule in
   * mapping.json skipColumns or GLOBAL_SKIP_PATTERNS). Distinct from
   * columnFieldMap so the verbose reporter can show them separately.
   */
  skippedColumnTitles: Set<string>;
  /**
   * Columns that had a value but weren't matched to any Lead field.
   * These are passed raw to the AI synthesizer.
   */
  unmappedColumns: MondayColumnValue[];
  /** The item's raw name (used as company fallback) */
  itemName: string;
}
