import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Cloud } from 'lucide-react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Item } from '@astryxdesign/core/Item';
import { List } from '@astryxdesign/core/List';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';

import {
  archiveGcsBucket,
  createGcsBucket,
  fetchGcsBuckets,
  fetchGroups,
  setGcsBucketGrants,
  updateGcsBucket,
  type GcsBucketRegistration,
  type ManagedGroup,
} from '../../../services/settingsApi';
import {
  SettingsEmptyState,
  SettingsLoadingState,
  SettingsNotice,
  SettingsSectionHeader,
} from './SettingsScaffold';

/**
 * Admin registry for the Cloud Storage connector. Registration is what makes a
 * bucket reachable at all; reads still run under each user's own OAuth token, so
 * GCS IAM remains the final word on what any one person can see.
 */
const GcsBucketsTab: React.FC = () => {
  const [buckets, setBuckets] = useState<GcsBucketRegistration[]>([]);
  const [teams, setTeams] = useState<ManagedGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyBucketId, setBusyBucketId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [draftBucketName, setDraftBucketName] = useState('');
  const [draftPrefix, setDraftPrefix] = useState('');
  const [draftDisplayName, setDraftDisplayName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [bucketRows, teamRows] = await Promise.all([
        fetchGcsBuckets({ includeArchived: true }),
        fetchGroups(),
      ]);
      setBuckets(bucketRows);
      setTeams(teamRows);
      setError(null);
    } catch (caught) {
      console.error('Failed to load Cloud Storage buckets', caught);
      setError(caught instanceof Error ? caught.message : 'Failed to load Cloud Storage buckets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleBuckets = useMemo(
    () => buckets.filter((bucket) => showArchived || !bucket.isArchived),
    [buckets, showArchived],
  );

  const replaceBucket = (updated: GcsBucketRegistration) => {
    setBuckets((prev) => prev.map((bucket) => (bucket.id === updated.id ? updated : bucket)));
  };

  const runBucketAction = async (
    bucketId: string,
    action: () => Promise<GcsBucketRegistration>,
    failureMessage: string,
  ) => {
    setBusyBucketId(bucketId);
    try {
      replaceBucket(await action());
      setError(null);
    } catch (caught) {
      console.error(failureMessage, caught);
      setError(caught instanceof Error ? caught.message : failureMessage);
    } finally {
      setBusyBucketId(null);
    }
  };

  const handleCreate = async () => {
    if (!draftBucketName.trim()) {
      return;
    }
    setIsCreating(true);
    try {
      const created = await createGcsBucket({
        bucketName: draftBucketName,
        pathPrefix: draftPrefix,
        displayName: draftDisplayName,
      });
      setBuckets((prev) => [...prev, created]);
      setDraftBucketName('');
      setDraftPrefix('');
      setDraftDisplayName('');
      setError(null);
    } catch (caught) {
      console.error('Failed to register Cloud Storage bucket', caught);
      setError(caught instanceof Error ? caught.message : 'Failed to register Cloud Storage bucket');
    } finally {
      setIsCreating(false);
    }
  };

  const toggleTeamGrant = (bucket: GcsBucketRegistration, teamId: string, granted: boolean) => {
    const next = bucket.teamGrants
      .filter((grant) => grant.teamId !== teamId)
      .map((grant) => ({ teamId: grant.teamId, effect: grant.effect }));
    if (granted) {
      next.push({ teamId, effect: 'allow' });
    }
    void runBucketAction(
      bucket.id,
      () => setGcsBucketGrants(bucket.id, next),
      'Failed to update Cloud Storage bucket grants',
    );
  };

  if (loading) {
    return <SettingsLoadingState label="Loading Cloud Storage buckets..." />;
  }

  return (
    <VStack gap={3}>
      <SettingsSectionHeader
        eyebrow="Cloud Storage"
        title="Importable buckets"
        description="Register the buckets people may import from, then grant each one to the teams that need it. Reads use each user's own Google account, so bucket IAM still applies on top."
      />

      {error && <SettingsNotice variant="error">{error}</SettingsNotice>}

      <VStack gap={2}>
        <Text type="label">Register a bucket</Text>
        <HStack gap={2} vAlign="end">
          <TextInput
            label="Bucket name"
            placeholder="analytics-raw"
            value={draftBucketName}
            onChange={setDraftBucketName}
          />
          <TextInput
            label="Path prefix"
            isOptional
            placeholder="exports/"
            description="Confines browsing to a subtree"
            value={draftPrefix}
            onChange={setDraftPrefix}
          />
          <TextInput
            label="Display name"
            isOptional
            placeholder="Analytics raw"
            value={draftDisplayName}
            onChange={setDraftDisplayName}
          />
          <Button
            label={isCreating ? 'Registering…' : 'Register'}
            variant="primary"
            isDisabled={isCreating || !draftBucketName.trim()}
            onClick={() => { void handleCreate(); }}
          />
        </HStack>
      </VStack>

      <SegmentedControl
        label="Show"
        size="sm"
        value={showArchived ? 'all' : 'active'}
        onChange={(value) => setShowArchived(value === 'all')}
      >
        <SegmentedControlItem value="active" label="Active" />
        <SegmentedControlItem value="all" label="Including archived" />
      </SegmentedControl>

      {!visibleBuckets.length ? (
        <SettingsEmptyState
          icon={Cloud}
          title="No buckets registered"
          description="Register a bucket above to let people import objects from Cloud Storage."
        />
      ) : (
        <List header="Registered buckets" hasDividers>
          {visibleBuckets.map((bucket) => {
            const allowedTeamIds = new Set(
              bucket.teamGrants.filter((grant) => grant.effect === 'allow').map((grant) => grant.teamId),
            );
            return (
              <Item
                key={bucket.id}
                as="li"
                align="start"
                label={(
                  <HStack gap={1} vAlign="center">
                    <Text type="body" weight="semibold">{bucket.displayName}</Text>
                    {bucket.isArchived && <Badge variant="neutral" label="Archived" />}
                    {bucket.defaultAccess === 'allow' && <Badge variant="warning" label="Open to everyone" />}
                  </HStack>
                )}
                description={(
                  <VStack gap={1}>
                    <Text type="supporting">{`gs://${bucket.bucketName}/${bucket.pathPrefix}`}</Text>
                    {teams.length ? (
                      <HStack gap={2}>
                        {teams.map((team) => (
                          <CheckboxInput
                            key={team.id}
                            size="sm"
                            label={team.name}
                            value={allowedTeamIds.has(team.id)}
                            isDisabled={busyBucketId === bucket.id || bucket.isArchived}
                            onChange={(checked) => toggleTeamGrant(bucket, team.id, checked)}
                          />
                        ))}
                      </HStack>
                    ) : (
                      <Text type="supporting">Create a team before granting access.</Text>
                    )}
                  </VStack>
                )}
                endContent={bucket.isArchived ? (
                  <Button
                    label="Restore"
                    variant="secondary"
                    size="sm"
                    isDisabled={busyBucketId === bucket.id}
                    onClick={() => void runBucketAction(
                      bucket.id,
                      () => updateGcsBucket(bucket.id, { isArchived: false }),
                      'Failed to restore Cloud Storage bucket',
                    )}
                  />
                ) : (
                  <Button
                    label="Archive"
                    variant="secondary"
                    size="sm"
                    isDisabled={busyBucketId === bucket.id}
                    onClick={() => void runBucketAction(
                      bucket.id,
                      () => archiveGcsBucket(bucket.id),
                      'Failed to archive Cloud Storage bucket',
                    )}
                  />
                )}
              />
            );
          })}
        </List>
      )}
    </VStack>
  );
};

export default GcsBucketsTab;
