import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBearerToken, generatePolicy } from '../lambda/authorizer/index.mjs';

test('extractBearerToken parses case-insensitive scheme', () => {
  assert.equal(extractBearerToken('Bearer abc'), 'abc');
  assert.equal(extractBearerToken('bearer abc'), 'abc');
  assert.equal(extractBearerToken('abc'), null);
  assert.equal(extractBearerToken(''), null);
  assert.equal(extractBearerToken(undefined), null);
});

test('generatePolicy encodes Allow/Deny and context flag', () => {
  const allow = generatePolicy('tok', 'Allow', 'arn:x');
  assert.equal(allow.policyDocument.Statement[0].Effect, 'Allow');
  assert.equal(allow.policyDocument.Statement[0].Resource, 'arn:x');
  assert.equal(allow.context.tokenValidated, 'true');
  const deny = generatePolicy('tok', 'Deny', 'arn:x');
  assert.equal(deny.policyDocument.Statement[0].Effect, 'Deny');
  assert.equal(deny.context.tokenValidated, 'false');
});
