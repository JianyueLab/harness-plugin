import { readdirSync } from 'node:fs';
import { join } from 'node:path';

function entries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** `<root>/<dir>/*.jsonl`, exactly one directory level below root. */
export function jsonlInSubdirs(root) {
  const out = [];
  for (const dir of entries(root)) {
    if (!dir.isDirectory()) continue;
    for (const file of entries(join(root, dir.name))) {
      if (file.isFile() && file.name.endsWith('.jsonl')) out.push(join(root, dir.name, file.name));
    }
  }
  return out;
}

/** Files accepted by `accept(name)` exactly `depth` directory levels below root. */
export function filesAtDepth(root, depth, accept) {
  if (depth === 0) {
    return entries(root).filter((e) => e.isFile() && accept(e.name)).map((e) => join(root, e.name));
  }
  return entries(root)
    .filter((e) => e.isDirectory())
    .flatMap((e) => filesAtDepth(join(root, e.name), depth - 1, accept));
}
