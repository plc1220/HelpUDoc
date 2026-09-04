import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Breadcrumbs, BreadcrumbItem } from '@astryxdesign/core/Breadcrumbs';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Item } from '@astryxdesign/core/Item';
import { List } from '@astryxdesign/core/List';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';

import {
  browseGcsObjects,
  GoogleScopeMissingError,
  listGcsBuckets,
} from '../../services/fileApi';
import { API_URL } from '../../services/apiClient';
import type { GcsBrowseEntry, GcsBucketSummary } from '../../types';
import {
  formatGcsSize,
  gcsBreadcrumbs,
  parentGcsPrefix,
  sortGcsEntries,
} from '../../utils/gcsPaths';

type Props = {
  isOpen: boolean;
  workspaceId?: string;
  onClose: () => void;
  onConfirm: (bucket: GcsBucketSummary, entries: GcsBrowseEntry[]) => void | Promise<void>;
};

/** Sends the user back through consent, returning them to where they were. */
const reconnectGoogle = () => {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`${API_URL}/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`);
};

export default function GcsPickerModal({ isOpen, workspaceId, onClose, onConfirm }: Props) {
  const [buckets, setBuckets] = useState<GcsBucketSummary[]>([]);
  const [activeBucket, setActiveBucket] = useState<GcsBucketSummary | null>(null);
  const [prefix, setPrefix] = useState('');
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<GcsBrowseEntry[]>([]);
  const [selectedByPath, setSelectedByPath] = useState<Record<string, GcsBrowseEntry>>({});
  const [isLoadingBuckets, setIsLoadingBuckets] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const requestKeyRef = useRef('');

  const reportError = useCallback((caught: unknown, fallback: string) => {
    if (caught instanceof GoogleScopeMissingError) {
      setNeedsReconnect(true);
      setError(caught.message);
      return;
    }
    setError(caught instanceof Error ? caught.message : fallback);
  }, []);

  useEffect(() => {
    if (isOpen) {
      return;
    }
    setBuckets([]);
    setActiveBucket(null);
    setPrefix('');
    setQuery('');
    setEntries([]);
    setSelectedByPath({});
    setIsLoadingBuckets(false);
    setIsLoading(false);
    setIsLoadingMore(false);
    setError(null);
    setNeedsReconnect(false);
    setNextPageToken(null);
    requestKeyRef.current = '';
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !workspaceId) {
      return;
    }
    let cancelled = false;
    setIsLoadingBuckets(true);
    setError(null);
    setNeedsReconnect(false);
    listGcsBuckets(workspaceId)
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setBuckets(payload.buckets);
        // One bucket needs no choosing; open it straight away.
        if (payload.buckets.length === 1) {
          setActiveBucket(payload.buckets[0]);
          setPrefix(payload.buckets[0].pathPrefix);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          reportError(caught, 'Failed to list Cloud Storage buckets.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingBuckets(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, workspaceId, reportError]);

  useEffect(() => {
    if (!isOpen || !workspaceId || !activeBucket) {
      return;
    }

    const timer = window.setTimeout(async () => {
      const requestKey = `${activeBucket.id}::${prefix}::${query.trim()}`;
      requestKeyRef.current = requestKey;
      setIsLoading(true);
      setError(null);
      try {
        const payload = await browseGcsObjects(workspaceId, {
          bucketId: activeBucket.id,
          prefix,
          query,
        });
        if (requestKeyRef.current !== requestKey) {
          return;
        }
        setEntries(sortGcsEntries(payload.entries));
        setNextPageToken(payload.nextPageToken ?? null);
      } catch (caught) {
        if (requestKeyRef.current !== requestKey) {
          return;
        }
        reportError(caught, 'Failed to list Cloud Storage objects.');
        setEntries([]);
        setNextPageToken(null);
      } finally {
        if (requestKeyRef.current === requestKey) {
          setIsLoading(false);
        }
      }
    }, query.trim() ? 250 : 0);

    return () => window.clearTimeout(timer);
  }, [isOpen, workspaceId, activeBucket, prefix, query, reportError]);

  const loadMore = useCallback(async () => {
    if (!workspaceId || !activeBucket || !nextPageToken || isLoading || isLoadingMore) {
      return;
    }
    const requestKey = requestKeyRef.current;
    setIsLoadingMore(true);
    try {
      const payload = await browseGcsObjects(workspaceId, {
        bucketId: activeBucket.id,
        prefix,
        query,
        pageToken: nextPageToken,
      });
      if (requestKeyRef.current !== requestKey) {
        return;
      }
      setEntries((prev) => {
        const seen = new Set(prev.map((entry) => entry.path));
        return sortGcsEntries([...prev, ...payload.entries.filter((entry) => !seen.has(entry.path))]);
      });
      setNextPageToken(payload.nextPageToken ?? null);
    } catch (caught) {
      reportError(caught, 'Failed to load more Cloud Storage objects.');
    } finally {
      setIsLoadingMore(false);
    }
  }, [workspaceId, activeBucket, nextPageToken, isLoading, isLoadingMore, prefix, query, reportError]);

  const selectedEntries = useMemo(
    () => Object.values(selectedByPath).sort((a, b) => a.name.localeCompare(b.name)),
    [selectedByPath],
  );

  const crumbs = useMemo(
    () => gcsBreadcrumbs(prefix, activeBucket?.pathPrefix || ''),
    [prefix, activeBucket],
  );

  const openBucket = (bucket: GcsBucketSummary) => {
    setActiveBucket(bucket);
    setPrefix(bucket.pathPrefix);
    setQuery('');
    setEntries([]);
    setNextPageToken(null);
    // Selections are per-bucket: object keys are only unique within one.
    setSelectedByPath({});
  };

  const navigateTo = (nextPrefix: string) => {
    setPrefix(nextPrefix);
    setQuery('');
    setEntries([]);
    setNextPageToken(null);
  };

  const toggleEntry = (entry: GcsBrowseEntry) => {
    setSelectedByPath((prev) => {
      if (prev[entry.path]) {
        const next = { ...prev };
        delete next[entry.path];
        return next;
      }
      return { ...prev, [entry.path]: entry };
    });
  };

  const atRoot = prefix === (activeBucket?.pathPrefix || '');

  return (
    <Dialog isOpen={isOpen} onOpenChange={onClose} width={880} purpose="form">
      <DialogHeader
        title="Import from Google Cloud Storage"
        subtitle={activeBucket
          ? `gs://${activeBucket.bucketName}/${prefix}`
          : 'Pick a bucket your administrator has made available.'}
        onOpenChange={onClose}
      />
      <VStack gap={2} padding={3} isScrollable>
        {error && (
          <Banner
            status="error"
            title={needsReconnect ? 'Google needs your permission for Cloud Storage' : 'Could not reach Cloud Storage'}
            description={error}
            endContent={needsReconnect ? (
              <Button label="Reconnect Google" variant="secondary" size="sm" onClick={reconnectGoogle} />
            ) : undefined}
          />
        )}

        {isLoadingBuckets && <Spinner label="Loading buckets…" />}

        {!isLoadingBuckets && !buckets.length && !error && (
          <EmptyState
            title="No buckets are available to you"
            description="An administrator registers Cloud Storage buckets and grants them to teams. Ask yours to add one."
          />
        )}

        {buckets.length > 1 && (
          <List header="Buckets" density="compact" hasDividers>
            {buckets.map((bucket) => (
              <Item
                key={bucket.id}
                as="li"
                density="compact"
                label={bucket.displayName}
                description={`gs://${bucket.bucketName}/${bucket.pathPrefix}`}
                endContent={activeBucket?.id === bucket.id ? <Text type="supporting">Open</Text> : undefined}
                onClick={() => openBucket(bucket)}
              />
            ))}
          </List>
        )}

        {activeBucket && (
          <VStack gap={2}>
            <TextInput
              label="Filter by name"
              isLabelHidden
              placeholder="Filter this folder by name prefix"
              value={query}
              onChange={setQuery}
              hasClear
            />

            <HStack gap={1} vAlign="center">
              <Breadcrumbs variant="supporting">
                <BreadcrumbItem onClick={() => navigateTo(activeBucket.pathPrefix)}>
                  {activeBucket.bucketName}
                </BreadcrumbItem>
                {crumbs.map((crumb, index) => (
                  <BreadcrumbItem
                    key={crumb.prefix}
                    isCurrent={index === crumbs.length - 1}
                    onClick={() => navigateTo(crumb.prefix)}
                  >
                    {crumb.label}
                  </BreadcrumbItem>
                ))}
              </Breadcrumbs>
            </HStack>

            {isLoading ? (
              <Spinner label="Loading objects…" />
            ) : !entries.length ? (
              <EmptyState
                title="This folder is empty"
                description={query.trim()
                  ? 'No object in this folder starts with that text.'
                  : 'Nothing here yet.'}
              />
            ) : (
              <List header="Objects" density="compact" hasDividers>
                {!atRoot && (
                  <Item
                    as="li"
                    density="compact"
                    label="Up one level"
                    onClick={() => navigateTo(parentGcsPrefix(prefix))}
                  />
                )}
                {entries.map((entry) => (entry.kind === 'prefix' ? (
                  <Item
                    key={entry.path}
                    as="li"
                    density="compact"
                    label={entry.name}
                    description="Folder"
                    onClick={() => navigateTo(entry.path)}
                  />
                ) : (
                  <Item
                    key={entry.path}
                    as="li"
                    density="compact"
                    label={entry.name}
                    description={entry.updated ? new Date(entry.updated).toLocaleString() : undefined}
                    startContent={(
                      <CheckboxInput
                        label={`Select ${entry.name}`}
                        isLabelHidden
                        size="sm"
                        value={Boolean(selectedByPath[entry.path])}
                        onChange={() => toggleEntry(entry)}
                      />
                    )}
                    endContent={<Text type="supporting">{formatGcsSize(entry.sizeBytes)}</Text>}
                  />
                )))}
              </List>
            )}

            {nextPageToken && (
              <Button
                label={isLoadingMore ? 'Loading…' : 'Load more'}
                variant="secondary"
                size="sm"
                isDisabled={isLoadingMore}
                onClick={() => { void loadMore(); }}
              />
            )}
          </VStack>
        )}

        <HStack gap={2} hAlign="between" vAlign="center">
          <Text type="supporting">
            {selectedEntries.length
              ? `${selectedEntries.length} object${selectedEntries.length === 1 ? '' : 's'} ready to import`
              : 'Select one or more objects'}
          </Text>
          <HStack gap={1}>
            <Button label="Cancel" variant="secondary" onClick={onClose} />
            <Button
              label="Import objects"
              variant="primary"
              isDisabled={!selectedEntries.length || !activeBucket}
              onClick={() => {
                if (activeBucket && selectedEntries.length) {
                  void onConfirm(activeBucket, selectedEntries);
                }
              }}
            />
          </HStack>
        </HStack>
      </VStack>
    </Dialog>
  );
}
