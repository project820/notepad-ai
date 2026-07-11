import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tessdataDir = resolve(repoRoot, 'resources', 'tessdata');
const minimumBytes = 100 * 1024;
const requiredFiles = ['eng.traineddata.gz', 'kor.traineddata.gz'];
const failures = [];

for (const name of requiredFiles) {
  const path = resolve(tessdataDir, name);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    failures.push(`${name}: missing (${path})`);
    continue;
  }

  if (!stat.isFile()) {
    failures.push(`${name}: expected a file (${path})`);
    continue;
  }

  if (stat.size <= minimumBytes) {
    failures.push(`${name}: too small (${stat.size} bytes; expected more than ${minimumBytes} bytes)`);
    continue;
  }

  const magic = Buffer.alloc(2);
  try {
    const fd = openSync(path, 'r');
    try {
      readSync(fd, magic, 0, magic.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    failures.push(`${name}: unreadable (${path})`);
    continue;
  }

  if (magic[0] !== 0x1f || magic[1] !== 0x8b) {
    failures.push(`${name}: not a gzip file (expected magic bytes 1f 8b)`);
    continue;
  }

  console.log(`[tessdata] OK ${name} (${Math.round(stat.size / 1024 / 1024)} MiB, gzip)`);
}

if (failures.length > 0) {
  console.error('\n[tessdata] FAILED: required offline OCR data is missing or invalid.');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('\nRestore the committed files with:');
  console.error('  git restore resources/tessdata');
  console.error('Or download the compressed Tesseract best language data (do not decompress):');
  console.error('  curl -L -o resources/tessdata/eng.traineddata.gz https://github.com/naptha/tessdata/raw/gh-pages/4.0.0_best/eng.traineddata.gz');
  console.error('  curl -L -o resources/tessdata/kor.traineddata.gz https://github.com/naptha/tessdata/raw/gh-pages/4.0.0_best/kor.traineddata.gz');
  process.exit(1);
}

console.log('[tessdata] PASS: offline OCR language data is ready for packaging.');
