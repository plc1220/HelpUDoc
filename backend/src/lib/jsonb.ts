import { Knex } from 'knex';

/**
 * Serialize a value for insertion into a Postgres `jsonb` column.
 *
 * The `pg` driver JSON-encodes plain objects automatically, but a raw JS
 * **array** is coerced into a Postgres array literal (`{...}`) instead of JSON,
 * which Postgres rejects with `invalid input syntax for type json`. Always route
 * `jsonb` values through this helper (or `JSON.stringify` for a bare batchInsert
 * value) so arrays are encoded correctly.
 *
 * Returns `null` for `null`/`undefined` so nullable `jsonb` columns stay null
 * rather than becoming the JSON string "null".
 */
export const jsonbParam = (db: Knex, value: unknown): Knex.Raw | null => (
  value === null || typeof value === 'undefined'
    ? null
    : db.raw('?::jsonb', [JSON.stringify(value)])
);