import assert from 'node:assert/strict';
import test from 'node:test';
import {
  redactSensitiveText,
  safeErrorForLog,
  safeTelemetryForPersistence,
} from '../src/lib/safeError';

test('safeErrorForLog removes credentials from request-shaped errors', () => {
  const sanitized = safeErrorForLog({
    name: 'AxiosError',
    message: 'Request failed',
    config: {
      headers: {
        Authorization: 'Bearer top-secret-token',
        Cookie: 'session=private',
        'X-Request-Id': 'request-123',
      },
    },
    response: {
      status: 502,
    },
  });
  const serialized = JSON.stringify(sanitized);

  assert.doesNotMatch(serialized, /top-secret-token|session=private/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /request-123/);
  assert.match(serialized, /502/);
});

test('safeErrorForLog limits Error output to diagnostic fields', () => {
  const error = Object.assign(new Error('upstream unavailable'), {
    code: 'ECONNRESET',
    response: { status: 503 },
    config: {
      headers: {
        Authorization: 'Bearer should-not-appear',
      },
    },
  });
  const sanitized = safeErrorForLog(error);
  const serialized = JSON.stringify(sanitized);

  assert.doesNotMatch(serialized, /should-not-appear|Authorization/);
  assert.match(serialized, /upstream unavailable/);
  assert.match(serialized, /ECONNRESET/);
  assert.match(serialized, /503/);
});

test('redactSensitiveText removes synthetic PII and credential markers', () => {
  const sanitized = redactSensitiveText(
    'qc-person-1@example.invalid +60-000-000-0001 tok_qc_only_001 secret=not-a-secret-marker-001',
  );

  assert.doesNotMatch(
    sanitized,
    /qc-person-1@example\.invalid|\+60-000-000-0001|tok_qc_only_001|not-a-secret-marker-001/,
  );
  assert.match(sanitized, /\[REDACTED_EMAIL\]/);
  assert.match(sanitized, /\[REDACTED_PHONE\]/);
  assert.match(sanitized, /\[REDACTED_TOKEN\]/);
});

test('safeTelemetryForPersistence redacts sensitive CSV columns in tool summaries', () => {
  const sanitized = safeTelemetryForPersistence({
    type: 'tool_end',
    name: 'read_file',
    content: [
      '1\torder_id,revenue,contact_email,phone,payment_token,api_secret',
      '2\tSENSITIVE-001,125.00,qc-person-1@example.invalid,+60-000-000-0001,tok_qc_only_001,not-a-secret-marker-001',
    ].join('\n'),
  });
  const serialized = JSON.stringify(sanitized);

  assert.doesNotMatch(
    serialized,
    /qc-person-1@example\.invalid|\+60-000-000-0001|tok_qc_only_001|not-a-secret-marker-001/,
  );
  assert.match(serialized, /SENSITIVE-001,125\.00,\[REDACTED\],\[REDACTED\],\[REDACTED\],\[REDACTED\]/);
});
