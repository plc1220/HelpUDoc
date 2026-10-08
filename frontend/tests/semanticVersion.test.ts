import assert from 'node:assert/strict';
import test from 'node:test';

import { describeProposedVersionProblem } from '@helpudoc/contracts/semanticVersion';

test('a new skill accepts only 1.0.0', () => {
  assert.equal(describeProposedVersionProblem('1.0.0', 'new'), null);
  assert.equal(describeProposedVersionProblem(' 1.0.0 ', 'new'), null);
  assert.equal(describeProposedVersionProblem('1.0.1', 'new'), 'A new skill must start at version 1.0.0.');
});

test('a two-part version explains the format', () => {
  assert.equal(
    describeProposedVersionProblem('1.0', 'new'),
    '"1.0" is not a valid version. Use major.minor.patch, for example 1.0.0.',
  );
});

test('an improvement accepts any well-formed version', () => {
  assert.equal(describeProposedVersionProblem('2.3.10', 'improvement'), null);
});

test('prerelease tags, leading zeros and empty input are rejected', () => {
  for (const value of ['1.0.0-beta', '01.0.0', 'v1.0.0', 'abcde']) {
    assert.match(describeProposedVersionProblem(value, 'improvement') ?? '', /not a valid version/, value);
  }
  assert.match(describeProposedVersionProblem('  ', 'improvement') ?? '', /^Enter a proposed version/);
});
