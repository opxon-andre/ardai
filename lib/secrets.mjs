import fs from 'node:fs';
import path from 'node:path';

// Kopiert Dateien, die in `from` neu entstanden sind, nach `to`; vorhandene Dateien werden nie überschrieben.
export function mergeNewSecrets(from, to) {
  let added = 0;
  const walk = (a, b) => {
    for (const entry of fs.readdirSync(a, { withFileTypes: true })) {
      const x = path.join(a, entry.name);
      const y = path.join(b, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(y, { recursive: true });
        walk(x, y);
      } else if (entry.isFile() && !fs.existsSync(y)) {
        fs.copyFileSync(x, y);
        added++;
      }
    }
  };
  if (fs.existsSync(from) && fs.existsSync(to)) walk(from, to);
  return added;
}
