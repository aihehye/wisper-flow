import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release');
fs.mkdirSync(releaseDir, { recursive: true });

const tarPath = path.join(releaseDir, 'wisper-flow-omarchy-src.tar.gz');
const outSh = path.join(releaseDir, 'wisper-flow-omarchy-installer.sh');

const itemsToPack = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'vite.config.ts',
  'README.md',
  'assets',
  'linux',
  'scripts',
  'src',
  'tests',
].filter((p) => fs.existsSync(path.join(root, p)));

execFileSync('tar', ['-czf', tarPath, ...itemsToPack], { cwd: root, stdio: 'inherit' });

const header = `#!/usr/bin/env bash
set -euo pipefail

DEST="\${HOME}/.local/share/wisper-flow-app"
mkdir -p "\$DEST"
ARCHIVE_LINE=\$(awk '/^__ARCHIVE_BELOW__\$/ {print NR + 1; exit 0;}' "\$0")
tail -n +"$ARCHIVE_LINE" "\$0" | tar -xz -C "\$DEST"
cd "\$DEST"
chmod +x linux/install-omarchy.sh linux/wisper-flow.sh linux/wisper-flow-ctl.sh
exec bash linux/install-omarchy.sh
exit 0
__ARCHIVE_BELOW__
`;

const headerBuf = Buffer.from(header.replace(/\r\n/g, '\n'), 'utf8');
const tarBuf = fs.readFileSync(tarPath);
fs.writeFileSync(outSh, Buffer.concat([headerBuf, tarBuf]));
try { fs.unlinkSync(tarPath); } catch {}

console.log(`Built ${outSh} (${(fs.statSync(outSh).size / 1024).toFixed(1)} KB)`);
