/**
 * The reporter's argument parsing, in its own module so it can be tested.
 *
 * It lived in `reporter.mjs`, which cannot be imported without running
 * `main()` — so the one function that runs on literally every hook invocation
 * had no coverage at all.
 */

/**
 * Parse the arguments the launcher passes through.
 *
 * The command used to be "the first thing starting with `--`", which now would
 * read `--host` as the command. Hooks pass nothing at all, so `--hook` stays
 * the default; an unknown `--flag` still becomes the command, so it reaches the
 * dispatch in `main()` and falls through to the hook path rather than being
 * silently dropped here.
 */
export function parseArgs(argv) {
  const out = { command: "--hook", host: "claude-code", days: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--host") { out.host = argv[++i] ?? out.host; continue; }
    if (arg === "--detach") continue;            // handled by scripts/run
    if (arg.startsWith("--")) { out.command = arg; continue; }
    if (/^\d+$/.test(arg)) out.days = Number(arg);
  }
  return out;
}
