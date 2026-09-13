/**
 * Extension -> WakaTime language name.
 *
 * This is measurably coarser than wakatime-cli, which sniffs file content.
 * That is the accepted cost of not shipping a 10MB binary; an unknown
 * extension omits the field entirely and WakaTime's server guesses from the
 * entity, which is better than asserting something wrong.
 */
import path from "node:path";

const TABLE = {
  ".go": "Go",
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript",
  ".astro": "Astro", ".vue": "Vue.js", ".svelte": "Svelte",
  ".py": "Python", ".rb": "Ruby", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
  ".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".hpp": "C++",
  ".cs": "C#", ".swift": "Swift", ".php": "PHP", ".lua": "Lua", ".zig": "Zig",
  ".sh": "Bash", ".bash": "Bash", ".zsh": "Bash", ".fish": "Fish",
  ".sql": "SQL", ".html": "HTML", ".css": "CSS", ".scss": "SASS",
  ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML", ".ini": "INI",
  ".md": "Markdown", ".mdx": "Markdown", ".rst": "reStructuredText", ".tex": "TeX",
  ".dockerfile": "Docker", ".tf": "Terraform", ".proto": "Protocol Buffer",
};

export function languageFor(filePath) {
  if (!filePath) return null;
  return TABLE[path.extname(String(filePath)).toLowerCase()] ?? null;
}
