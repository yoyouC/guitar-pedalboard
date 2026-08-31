import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuthConfigurationError,
  authenticationBaseURL,
} from '../server/auth/runtime.ts';

test('explicit auth URL remains authoritative in every environment', () => {
  const url = authenticationBaseURL({
    BETTER_AUTH_URL: 'https://auth.example.test/login',
    VERCEL_ENV: 'preview',
    VERCEL_URL: 'changing-preview.vercel.app',
  });
  assert.equal(url.href, 'https://auth.example.test/');
});

test('Vercel Preview uses its immutable deployment URL as the auth origin', () => {
  const url = authenticationBaseURL({
    VERCEL_ENV: 'preview',
    VERCEL_URL: 'guitar-pedalboard-preview.vercel.app',
  });
  assert.equal(url.href, 'https://guitar-pedalboard-preview.vercel.app/');
});

test('production still requires an explicit stable auth URL', () => {
  assert.throws(
    () => authenticationBaseURL({
      VERCEL_ENV: 'production',
      VERCEL_URL: 'guitar-pedalboard.vercel.app',
    }),
    AuthConfigurationError,
  );
});
