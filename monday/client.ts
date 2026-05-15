/**
 * monday/client.ts
 *
 * Thin wrapper around the Monday.com v2 GraphQL API.
 * Uses native Node fetch (Node 18+). No extra dependencies.
 *
 * Auth: Monday API tokens go in the Authorization header as a bare token
 * (no "Bearer" prefix). Generate one at:
 *   Monday.com → Avatar → Developers → My Access Tokens
 */

import type { MondayBoard, MondayItem } from "./types.js";

const API_URL = "https://api.monday.com/v2";

// In Monday's v2 API, `title` is not a direct field on column_values.
// It lives on the nested `column` object. We fetch it there and then
// flatten it onto the column_value so the rest of the codebase can
// use `col.title` without knowing about the nesting.
const ITEM_FIELDS = `
  id
  name
  board { id name }
  creator { id name email }
  column_values { id type text value column { title } }
`;

// Raw shape returned by the API before we flatten column.title.
interface RawColumnValue {
  id: string;
  type: string;
  text: string;
  value: string | null;
  column?: { title: string };
}

interface RawItem {
  id: string;
  name: string;
  board: { id: string; name: string };
  creator?: { id: string; name: string; email: string };
  column_values: RawColumnValue[];
}

// Flatten `column.title` → `title` on each column_value so the rest of
// the code can use `col.title` directly.
function normalizeItem(raw: unknown): MondayItem {
  const item = raw as RawItem;
  return {
    id: item.id,
    name: item.name,
    board: item.board,
    creator: item.creator,
    column_values: item.column_values.map((cv) => ({
      id: cv.id,
      title: cv.column?.title ?? cv.id, // fall back to id if title is missing
      text: cv.text ?? "",
      value: cv.value ?? null,
      type: cv.type,
    })),
  };
}

// ---------- Internal ----------

async function gql(apiKey: string, query: string): Promise<unknown> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
      // Monday recommends pinning an API version.
      "API-Version": "2023-10",
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(
      `Monday API HTTP ${res.status} ${res.statusText}:\n${body}`
    );
  }

  const json = (await res.json()) as {
    data?: unknown;
    errors?: Array<{ message: string; locations?: unknown }>;
  };

  if (json.errors?.length) {
    const msgs = json.errors.map((e) => e.message).join("\n");
    throw new Error(`Monday GraphQL error:\n${msgs}`);
  }

  return json.data;
}

// ---------- Public API ----------

/**
 * Fetch all items from a board (up to 100 items — Monday's default page size).
 * Pass `limit` to override. For boards with >100 items you'd need cursor
 * pagination; add that when integrating into the main system.
 */
export async function fetchBoard(
  apiKey: string,
  boardId: string,
  limit = 100
): Promise<MondayBoard> {
  const data = await gql(
    apiKey,
    `{
      boards(ids: [${boardId}]) {
        id
        name
        columns { id title type }
        items_page(limit: ${limit}) {
          items { ${ITEM_FIELDS} }
        }
      }
    }`
  );

  const boards = (data as { boards: MondayBoard[] }).boards;
  const board = boards?.[0];

  if (!board) {
    throw new Error(
      `Board "${boardId}" not found. ` +
        `Check the board ID and that your API key has access to it.`
    );
  }

  // Normalize column_values on every item to flatten column.title → title.
  board.items_page.items = board.items_page.items.map(normalizeItem);
  return board;
}

/**
 * Fetch a single item by its Monday item ID.
 * Useful when running --item <id> from the CLI.
 */
export async function fetchItem(
  apiKey: string,
  itemId: string
): Promise<MondayItem> {
  const data = await gql(
    apiKey,
    `{
      items(ids: [${itemId}]) { ${ITEM_FIELDS} }
    }`
  );

  const items = (data as { items: MondayItem[] }).items;
  const item = items?.[0];

  if (!item) {
    throw new Error(
      `Item "${itemId}" not found. ` +
        `Check the item ID and that your API key has access to it.`
    );
  }

  return normalizeItem(item);
}

/**
 * List the column schema of a board — handy for debugging what column
 * titles and types are available so you can fill in mapping.json.
 */
export async function fetchBoardColumns(
  apiKey: string,
  boardId: string
): Promise<Array<{ id: string; title: string; type: string }>> {
  const data = await gql(
    apiKey,
    `{
      boards(ids: [${boardId}]) {
        columns { id title type }
      }
    }`
  );

  const boards = (data as { boards: { columns: { id: string; title: string; type: string }[] }[] }).boards;
  return boards?.[0]?.columns ?? [];
}
