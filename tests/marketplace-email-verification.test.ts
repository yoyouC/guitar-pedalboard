import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMarketplaceEmailVerificationRequest } from '../src/members/emailVerification.ts';

test('verification entry accepts only the email route and a same-site return path', () => {
  assert.deepEqual(parseMarketplaceEmailVerificationRequest(
    '/login?verify=email&return=%2Fmarketplace%2Ftones%2Fpreset-1%2Fmanage',
  ), { returnPath: '/marketplace/tones/preset-1/manage' });
  assert.deepEqual(parseMarketplaceEmailVerificationRequest('/login?verify=email'), {
    returnPath: '/',
  });
  assert.equal(parseMarketplaceEmailVerificationRequest(
    '/login?verify=email&return=https%3A%2F%2Fevil.example',
  ), null);
  assert.equal(parseMarketplaceEmailVerificationRequest('/login?verify=phone'), null);
  assert.equal(parseMarketplaceEmailVerificationRequest('/marketplace'), null);
});
