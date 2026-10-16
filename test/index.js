// Node 24 resolves an explicit directory argument through index.js rather than
// discovering its test files. Keep the documented directory invocation working
// and include future tests automatically.
import fs from 'node:fs';

for (const file of fs.readdirSync(new URL('.', import.meta.url)).sort()) {
  if (file.endsWith('.test.mjs')) await import(new URL(file, import.meta.url));
}
