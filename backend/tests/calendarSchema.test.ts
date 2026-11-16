import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import knex from 'knex';
import { config } from 'dotenv';
import { ensureCalendarSchema } from '../src/services/calendarSchema';

test('existing Calendar tables gain usable compound indexes without casting provider dates', { skip: process.env.CALENDAR_INTEGRATION !== '1' }, async () => {
  config({ path: '../env/local/dev.env', quiet: true });
  const connection = process.env.DATABASE_URL || { host: '127.0.0.1', port: 5432, database: process.env.POSTGRES_DB || 'helpudoc', user: process.env.POSTGRES_USER || 'helpudoc', password: process.env.POSTGRES_PASSWORD || 'helpudoc' };
  const schema = `calendar_index_test_${randomUUID().replaceAll('-', '')}`;
  const admin = knex({ client: 'pg', connection });
  await admin.raw('CREATE SCHEMA ??', [schema]);
  const db = knex({ client: 'pg', connection, searchPath: [schema] });
  const userId = '11111111-1111-4111-8111-111111111111';
  try {
    await db.schema.createTable('users', table => table.uuid('id').primary());
    await db('users').insert({ id: userId });
    // This simulates a pre-existing table, so migration cannot rely on createTable.
    await db.schema.createTable('calendar_events', table => {
      table.string('id', 180).primary(); table.uuid('userId').notNullable(); table.text('resource').notNullable(); table.jsonb('data').notNullable(); table.timestamp('updatedAt').defaultTo(db.fn.now());
    });
    await db('calendar_events').insert({ id: 'malformed-provider-date', userId, resource: 'meeting:malformed', data: { calendar_id: 'calendar:a', event: { start: { dateTime: 'invalid-provider-date' } } } });
    await ensureCalendarSchema(db); await ensureCalendarSchema(db);
    const indexes = await db('pg_indexes').where({ schemaname: schema }).select('indexname', 'indexdef');
    assert.ok(indexes.some(row => row.indexname === 'calendar_events_user_calendar_start_idx'));
    assert.ok(indexes.some(row => row.indexname === 'calendar_links_user_resource_idx'));
    assert.ok(indexes.some(row => row.indexname === 'calendar_proposals_user_resource_idx'));
    assert.ok(indexes.some(row => row.indexname === 'calendar_watches_channel_idx'));
    const dateIndex = indexes.find(row => row.indexname === 'calendar_events_user_calendar_start_idx')!.indexdef;
    assert.match(dateIndex, /COALESCE/); assert.doesNotMatch(dateIndex, /timestamp/i);
    await db.transaction(async tx => {
      await tx.raw('SET LOCAL enable_seqscan = off');
      const plan = await tx.raw('EXPLAIN SELECT id FROM calendar_events WHERE "userId" = ? AND data->>\'calendar_id\' = ?', [userId, 'calendar:a']);
      assert.match(plan.rows.map((row: { 'QUERY PLAN': string }) => row['QUERY PLAN']).join('\n'), /calendar_events_user_calendar_start_idx/);
      const watchPlan = await tx.raw('EXPLAIN SELECT id FROM calendar_watches WHERE data->>\'channel_id\' = ?', ['opaque-channel']);
      assert.match(watchPlan.rows.map((row: { 'QUERY PLAN': string }) => row['QUERY PLAN']).join('\n'), /calendar_watches_channel_idx/);
    });
  } finally {
    await db.destroy(); await admin.raw('DROP SCHEMA ?? CASCADE', [schema]); await admin.destroy();
  }
});
