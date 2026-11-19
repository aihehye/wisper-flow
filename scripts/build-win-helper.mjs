import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

if (process.platform !== 'win32') {
  console.log('[skip] build:win-helper is Windows-only');
  process.exit(0);
}

const cscCandidates = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];
const csc = cscCandidates.find((p) => fs.existsSync(p));
if (!csc) {
  throw new Error('Could not find .NET Framework csc.exe');
}

const src = path.join(root, 'native', 'win-helper', 'WinHelper.cs');
const out = path.join(root, 'native', 'win-helper', 'wisper-win-helper.exe');

console.log('Compiling WinHelper.cs via', csc);
execFileSync(
  csc,
  [
    '/nologo',
    '/target:exe',
    '/platform:x64',
    '/optimize+',
    `/out:${out}`,
    '/r:System.dll',
    '/r:System.Core.dll',
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    '/r:System.Web.Extensions.dll',
    src,
  ],
  { stdio: 'inherit' }
);
console.log('Built', out, `(${fs.statSync(out).size} bytes)`);
