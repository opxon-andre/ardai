#!/usr/bin/env node
import fs from 'node:fs';

if (/username/i.test(process.argv[2] || '')) {
  process.stdout.write((process.env.ARDAI_GIT_USERNAME || 'git') + '\n');
} else {
  const file = process.env.ARDAI_GIT_TOKEN_FILE;
  if (!file) { console.error('Configure ARDAI_GIT_TOKEN_FILE for HTTPS Git authentication'); process.exit(1); }
  process.stdout.write(fs.readFileSync(file, 'utf8').trim() + '\n');
}
