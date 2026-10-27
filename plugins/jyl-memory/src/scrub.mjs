// Rules run in order. A rule with `pre`/`secret`/`post` groups keeps `pre` and `post` and replaces only
// `secret`; other rules replace the whole match. Lookbehind is avoided so Node (V8) and Bun (JSC) agree.
const RULES = [
  ['private_key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g],
  ['url_credential', /(?<pre>\b[a-z][a-z0-9+.-]{0,31}:\/\/)(?<secret>[^\s:@/]+:[^\s@/]+)(?<post>@)/gi],
  ['bearer', /(?<pre>\bAuthorization["']?\s*:\s*["']?Bearer\s+)(?<secret>(?!\[REDACTED)[A-Za-z0-9._~+/=-]{8,})/gi],
  ['openai_key', /\bsk-[A-Za-z0-9_-]{20,}/g],
  ['jyl_token', /\b(?:mem_|jyl-)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])|\bmat_[A-Za-z0-9_-]{32,}/g],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['aws_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['jwt', /(?<pre>^|[^A-Za-z0-9_-])(?<secret>eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g],
  [
    'env_secret',
    /(?<pre>\b(?:(?=[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD))[A-Z0-9_]+|(?=[a-z0-9_]*(?:_key|_token|_secret|password|passwd))[a-z0-9_]+)["']?[ \t]*[:=][ \t]*["']?)(?<secret>(?!\[REDACTED)[^\s"'`,;]{6,})/g,
  ],
];

/** Replaces known secret shapes with `[REDACTED:<type>]`. */
export function scrub(text) {
  let out = text;
  for (const [type, pattern] of RULES) {
    const marker = `[REDACTED:${type}]`;
    out = out.replace(pattern, (...args) => {
      const groups = args.at(-1);
      if (groups && typeof groups === 'object' && groups.secret !== undefined) {
        return `${groups.pre ?? ''}${marker}${groups.post ?? ''}`;
      }
      return marker;
    });
  }
  return out;
}
