import { describe, expect, test } from 'bun:test';
import { scrub } from '../src/scrub.mjs';

const b64 = (n) => 'Ab1_-'.repeat(Math.ceil(n / 5)).slice(0, n);

describe('scrub redacts', () => {
  const cases = [
    ['openai_key', `key is ${'sk-'}proj-${b64(40)} ok`],
    ['openai_key', `${'sk-'}ant-api03-${b64(40)}`],
    ['jyl_token', `token ${'mem'}_${b64(43)}`],
    ['jyl_token', `${'jyl'}-${b64(43)}`],
    ['jyl_token', `${'mat'}_${b64(40)}`],
    ['github_token', `${'gh'}p_${'a1'.repeat(18)}`],
    ['github_token', `${'github'}_pat_${'a1_'.repeat(12)}`],
    ['aws_key', `${'AKIA'}${'ABCDEFGH12345678'}`],
    ['jwt', `${'eyJ'}hbGciOiJIUzI1.${'eyJ'}zdWIiOiIx.c2lnbmF0dXJl`],
    ['bearer', `Authorization: Bearer ${'abcdef'}123456789`],
    ['bearer', `authorization: bearer ${'abcdef'}123456789`],
    ['env_secret', `export OPENAI_API_KEY=${'abc123'}def456`],
    ['env_secret', `"client_secret": "${'s3cr3t'}-value"`],
    ['env_secret', `password: ${'hunter'}22`],
    ['url_credential', `${'postgres:/'}/app:pa55word@db.internal:5432/app`],
  ];
  for (const [type, input] of cases) {
    test(`${type}: ${input.slice(0, 24)}`, () => {
      const out = scrub(input);
      expect(out).toContain(`[REDACTED:${type}]`);
    });
  }

  test('a private key block is replaced as a whole', () => {
    const block = `-----BEGIN ${'OPENSSH'} PRIVATE KEY-----\nAAAA\nBBBB\n-----END ${'OPENSSH'} PRIVATE KEY-----`;
    expect(scrub(`before\n${block}\nafter`)).toBe('before\n[REDACTED:private_key]\nafter');
  });

  test('a PGP private key block is replaced as a whole', () => {
    const block = `-----BEGIN ${'PGP'} PRIVATE KEY BLOCK-----\n\nlQOYBF\n=abcd\n-----END ${'PGP'} PRIVATE KEY BLOCK-----`;
    expect(scrub(`before\n${block}\nafter`)).toBe('before\n[REDACTED:private_key]\nafter');
  });

  test('the URL keeps its scheme and host', () => {
    expect(scrub(`${'https:/'}/bob:hunter2@example.com/x`)).toBe('https://[REDACTED:url_credential]@example.com/x');
  });

  test('an already redacted value is not re-labelled by env_secret', () => {
    expect(scrub(`API_KEY=${'sk-'}${b64(30)}`)).toBe('API_KEY=[REDACTED:openai_key]');
  });
});

describe('scrub leaves ordinary text alone', () => {
  const keep = [
    'the jyl-usage plugin and jyl-memory CLI',
    'primary key: user_id',
    'risk-assessment-framework-document-v2',
    'AKIA is a prefix',
    'Bearer token',
    'Use HTTP Bearer authentication for the API',
    'the Bearer credentials are checked',
    'monkey: bananas',
    'see https://example.com/path@v2',
  ];
  for (const text of keep) {
    test(text, () => expect(scrub(text)).toBe(text));
  }
});

describe('scrub runs in linear time', () => {
  const degenerate = ['KEY'.repeat(33_334), 'a.'.repeat(50_000), 'eyJ-'.repeat(25_000), 'key_'.repeat(25_000), 'a:'.repeat(50_000)];
  for (const input of degenerate) {
    test(`${input.slice(0, 8)}… (${input.length})`, () => {
      const start = performance.now();
      scrub(input);
      expect(performance.now() - start).toBeLessThan(200);
    });
  }
});
