// Verify a quiescent S3 bucket using streamed bytes and response metadata.
// Run in the backend image, which supplies @aws-sdk/client-s3 and credentials.
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function client(endpoint) {
  return new S3Client({
    endpoint, region: process.env.AWS_REGION || 'us-east-1', forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 5,
  });
}

function canonicalMetadata(value) {
  // rclone adds transfer timestamps. Application metadata must compare exactly.
  return JSON.stringify(Object.entries(value || {})
    .filter(([key]) => !['mtime', 'btime', 'tier'].includes(key))
    .sort(([a], [b]) => a.localeCompare(b)));
}

async function read(client, bucket, key) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error('Object response has no body');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of result.Body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return {
    bytes, sha256: hash.digest('hex'), mimeType: result.ContentType || null,
    metadata: result.Metadata || {}, etag: result.ETag,
  };
}

async function verifyBucket(bucket, reportDir, prefix = '') {
  if (!bucket) throw new Error('A bucket name is required');
  const source = client(process.env.MIGRATION_SOURCE_ENDPOINT || 'http://minio-rollback:9000');
  const target = client(process.env.MIGRATION_TARGET_ENDPOINT || 'http://rustfs:9000');
  const concurrency = Number(process.env.MIGRATION_VERIFY_CONCURRENCY || 64);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 128) {
    throw new Error('Verification concurrency must be between 1 and 128');
  }
  fs.mkdirSync(reportDir, { recursive: true });
  const manifest = fs.openSync(path.join(reportDir, bucket + '.objects.jsonl'), 'w');
  const startedAt = new Date().toISOString();
  const keys = new Set();
  const pending = new Set();
  const problems = [];
  let checked = 0, bytes = 0, targetCount = 0;
  const progress = () => console.log(JSON.stringify({ bucket, checked, listed: keys.size, bytes, errors: problems.length }));
  const timer = setInterval(progress, 30000);
  let summary;
  try {
    let token;
    do {
      const page = await source.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000,
      }));
      for (const listed of page.Contents || []) {
        const key = listed.Key;
        if (!key || keys.has(key)) throw new Error('Missing or duplicate source key');
        keys.add(key);
        const task = (async () => {
          try {
            const [a, b] = await Promise.all([read(source, bucket, key), read(target, bucket, key)]);
            if (a.bytes !== Number(listed.Size) || a.etag !== listed.ETag) {
              throw new Error('Source changed during verification');
            }
            if (a.bytes !== b.bytes || a.sha256 !== b.sha256) throw new Error('Byte/checksum mismatch');
            if (a.mimeType !== b.mimeType) throw new Error('Content type mismatch');
            if (canonicalMetadata(a.metadata) !== canonicalMetadata(b.metadata)) throw new Error('Custom metadata mismatch');
            fs.writeSync(manifest, JSON.stringify({ key, bytes: a.bytes, sha256: a.sha256, mimeType: a.mimeType, metadata: a.metadata }) + '\n');
            checked += 1;
            bytes += a.bytes;
          } catch (error) {
            problems.push({ key, error: error.message });
          }
        })();
        pending.add(task);
        task.finally(() => pending.delete(task));
        if (pending.size >= concurrency) await Promise.race(pending);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !token) throw new Error('Missing source continuation token');
    } while (token);
    await Promise.all(pending);
    // A second listing of the destination catches additional keys and duplicates.
    // Missing destination keys have already failed their object reads above.
    let targetToken;
    const targetKeys = new Set();
    do {
      const page = await target.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, ContinuationToken: targetToken, MaxKeys: 1000,
      }));
      for (const item of page.Contents || []) {
        if (!item.Key || targetKeys.has(item.Key)) throw new Error('Missing or duplicate target key');
        targetKeys.add(item.Key);
        targetCount += 1;
        if (!keys.has(item.Key)) problems.push({ key: item.Key, error: 'Destination-only key' });
      }
      targetToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !targetToken) throw new Error('Missing target continuation token');
    } while (targetToken);
    summary = {
      bucket, prefix, startedAt, finishedAt: new Date().toISOString(),
      sourceCount: keys.size, targetCount, checked, bytes, problems,
      passed: checked === keys.size && targetCount === keys.size && problems.length === 0,
    };
    fs.writeFileSync(path.join(reportDir, bucket + '.verification.json'), JSON.stringify(summary, null, 2));
    progress();
    console.log(JSON.stringify({ ...summary, problems: problems.slice(0,10) }));
    return summary;
  } finally {
    clearInterval(timer);
    await Promise.allSettled(pending);
    fs.closeSync(manifest);
    source.destroy();
    target.destroy();
  }
}

module.exports = { verifyBucket };
if (require.main === module) {
  const bucket = process.argv[2];
  const reportDir = process.argv[3] || '/reports';
  fs.mkdirSync(reportDir, { recursive: true });
  const exitFile = path.join(reportDir, bucket + '.verification.exit');
  // A retry must never leave an earlier success marker behind.
  fs.rmSync(exitFile, { force: true });
  fs.rmSync(path.join(reportDir, bucket + '.verification.json'), { force: true });
  verifyBucket(bucket, reportDir, process.argv[4] || '')
    .then(result => {
      process.exitCode = result.passed ? 0 : 1;
      fs.writeFileSync(exitFile, String(process.exitCode) + '\n');
    })
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
      fs.writeFileSync(exitFile, '1\n');
    });
}
