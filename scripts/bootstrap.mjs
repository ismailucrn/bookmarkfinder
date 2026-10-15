#!/usr/bin/env node
import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('Bookmark Finder requires Node.js 24 or newer. Install it and run npm run setup again.');
  }

  const envPath = join(root, '.env');
  // O_EXCL prevents an existing file or symlink from being overwritten.
  let envCreated = false;
  try {
    // Set the mode at creation, before any environment contents are written.
    const fd = openSync(envPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(fd, readFileSync(join(root, '.env.example')));
      envCreated = true;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  console.log(envCreated ? 'Created .env with private permissions (0600 or stricter).' : 'Preserved existing .env without reading or changing it.');

  const venvPath = join(root, '.venv');
  const pythonPath = join(venvPath, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  let venvExists = false;
  try {
    const entry = lstatSync(venvPath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Existing .venv is not a local directory; it was left untouched.');
    }
    venvExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (venvExists) {
    if (!existsSync(join(venvPath, 'pyvenv.cfg')) || !existsSync(pythonPath)) {
      throw new Error('Existing .venv is incomplete; it was left untouched. Repair or move it before rerunning setup.');
    }
    console.log('Preserved existing .venv.');
  } else {
    // The application remains Node-based. Python is only used for local ZIP packaging.
    const result = spawnSync('python3', ['-m', 'venv', '--without-pip', venvPath], { cwd: root, stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      throw new Error('Could not create .venv. Ensure python3 with venv support is installed. Any partial environment was left untouched.');
    }
    console.log('Created .venv using local Python; no packages were downloaded.');
  }
  console.log('Setup complete. Run npm run demo, npm start, or npm run package.');
}

// Built-ins only; no dependency installation or secret loading is required.
try {
  main();
} catch (error) {
  console.error(`Setup failed: ${error.message}`);
  process.exitCode = 1;
}
