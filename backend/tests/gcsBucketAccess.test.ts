import assert from 'node:assert/strict';
import test from 'node:test';
import { GcsBucketRegistryService, normalizeBucketName, normalizePathPrefix } from '../src/services/gcsBucketRegistryService';

type BucketSeed = { id: string; defaultAccess: 'allow' | 'deny' };
type GrantSeed = { bucketId: string; teamId: string; effect: 'allow' | 'deny' };

/**
 * A knex stand-in that answers the three queries `listAccessibleBuckets` makes.
 * Terminal calls resolve; intermediate ones keep the chain going, following the
 * Proxy approach in `workspaceSyncStatus.test.ts`.
 */
function buildRegistry(options: {
  buckets: BucketSeed[];
  teamIds: string[];
  grants: GrantSeed[];
  isPlatformAdmin?: boolean;
}) {
  const rows = options.buckets.map((bucket) => ({
    id: bucket.id,
    bucketName: `bucket-${bucket.id}`,
    pathPrefix: '',
    displayName: `Bucket ${bucket.id}`,
    description: null,
    defaultAccess: bucket.defaultAccess,
    isArchived: false,
    createdByUserId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  }));

  const db = ((table: string) => {
    if (table === 'gcs_buckets') {
      return {
        where: () => ({ orderBy: async () => rows }),
      };
    }
    if (table === 'group_members') {
      return {
        select: () => ({ where: async () => options.teamIds.map((groupId) => ({ groupId })) }),
      };
    }
    if (table === 'gcs_bucket_team_grants') {
      return {
        select: () => ({ whereIn: async () => options.grants }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  }) as any;

  const userService = {
    isPlatformAdmin: async () => Boolean(options.isPlatformAdmin),
  } as any;

  return new GcsBucketRegistryService(db, userService);
}

test('a platform admin sees every live bucket regardless of grants', async () => {
  const registry = buildRegistry({
    buckets: [{ id: 'a', defaultAccess: 'deny' }, { id: 'b', defaultAccess: 'deny' }],
    teamIds: [],
    grants: [],
    isPlatformAdmin: true,
  });

  const visible = await registry.listAccessibleBuckets('admin-1');

  assert.deepEqual(visible.map((bucket) => bucket.id), ['a', 'b']);
});

test('a deny-by-default bucket stays hidden without a team grant', async () => {
  const registry = buildRegistry({
    buckets: [{ id: 'a', defaultAccess: 'deny' }],
    teamIds: ['team-1'],
    grants: [],
  });

  assert.deepEqual(await registry.listAccessibleBuckets('user-1'), []);
});

test('a team allow grant opens a deny-by-default bucket', async () => {
  const registry = buildRegistry({
    buckets: [{ id: 'a', defaultAccess: 'deny' }],
    teamIds: ['team-1'],
    grants: [{ bucketId: 'a', teamId: 'team-1', effect: 'allow' }],
  });

  const visible = await registry.listAccessibleBuckets('user-1');

  assert.deepEqual(visible.map((bucket) => bucket.id), ['a']);
});

test('an explicit deny beats both defaultAccess allow and a sibling allow grant', async () => {
  const registry = buildRegistry({
    buckets: [{ id: 'a', defaultAccess: 'allow' }, { id: 'b', defaultAccess: 'deny' }],
    teamIds: ['team-1', 'team-2'],
    grants: [
      { bucketId: 'a', teamId: 'team-1', effect: 'deny' },
      { bucketId: 'b', teamId: 'team-1', effect: 'allow' },
      { bucketId: 'b', teamId: 'team-2', effect: 'deny' },
    ],
  });

  // 'a' is denied despite defaultAccess allow; 'b' is denied despite an allow on
  // the user's other team.
  assert.deepEqual(await registry.listAccessibleBuckets('user-1'), []);
});

test('requireAccessibleBucket refuses an ungranted bucket rather than reporting it missing', async () => {
  const registry = buildRegistry({
    buckets: [{ id: 'a', defaultAccess: 'deny' }],
    teamIds: ['team-1'],
    grants: [],
  });

  await assert.rejects(
    () => registry.requireAccessibleBucket('user-1', 'a'),
    (error: any) => {
      assert.equal(error.statusCode, 403);
      return true;
    },
  );
});

test('bucket names and prefixes normalise to one canonical form', () => {
  assert.equal(normalizeBucketName('  GS://Analytics-Raw/2026/  '), 'analytics-raw');
  assert.equal(normalizeBucketName('analytics-raw'), 'analytics-raw');

  assert.equal(normalizePathPrefix(undefined), '');
  assert.equal(normalizePathPrefix('  '), '');
  assert.equal(normalizePathPrefix('/exports'), 'exports/');
  assert.equal(normalizePathPrefix('exports/'), 'exports/');
  assert.equal(normalizePathPrefix('exports/2026'), 'exports/2026/');
});
