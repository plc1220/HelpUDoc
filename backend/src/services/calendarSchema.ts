import type { Knex } from 'knex';

/** Personal overlays follow the existing globally unique authenticated user boundary.
 * Provider credentials remain in the existing encrypted token vault. */
export async function ensureCalendarSchema(db: Knex) {
  for (const name of ['calendar_sources', 'calendar_events', 'calendar_mutations', 'calendar_links', 'calendar_briefs', 'calendar_commitments', 'calendar_audit', 'calendar_watches', 'calendar_proposals']) {
    if (await db.schema.hasTable(name)) continue;
    await db.schema.createTable(name, table => {
      table.string('id', 180).primary();
      table.uuid('userId').notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.text('resource').notNullable();
      table.jsonb('data').notNullable().defaultTo('{}');
      table.timestamp('updatedAt').notNullable().defaultTo(db.fn.now());
      table.index(['userId']);
      if (name === 'calendar_mutations') table.unique(['userId', 'resource']);
    });
  }
  // Run outside table creation so an existing installation receives indexes too.
  // These prefixes match the current per-user subject and calendar lookups.
  for (const table of ['calendar_sources', 'calendar_events', 'calendar_links', 'calendar_briefs', 'calendar_watches', 'calendar_proposals']) {
    await db.raw('CREATE INDEX IF NOT EXISTS ?? ON ?? ("userId", resource)', [`${table}_user_resource_idx`, table]);
  }
  // Keep provider time strings lexical: an index migration must not fail on a
  // malformed/absent provider date. The user/calendar prefix also accelerates
  // current projection reads; this expression is not a UTC range conversion.
  await db.raw(`CREATE INDEX IF NOT EXISTS calendar_events_user_calendar_start_idx ON calendar_events
    ("userId", (data->>'calendar_id'), (COALESCE(data->'event'->'start'->>'dateTime', data->'event'->'start'->>'date')))`);
  await db.raw(`CREATE INDEX IF NOT EXISTS calendar_watches_channel_idx ON calendar_watches ((data->>'channel_id'))`);
}
