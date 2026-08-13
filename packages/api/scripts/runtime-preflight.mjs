import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

function printNativeModuleFailure(err) {
  console.error('[runtime-preflight] better-sqlite3 native module failed to load.');
  console.error('[runtime-preflight] This usually means Node changed and native modules need rebuild.');
  console.error(`[runtime-preflight] Node: ${process.execPath} ${process.version} modules=${process.versions.modules}`);
  console.error('[runtime-preflight] Fix: PATH="$HOME/.uclaw/node/bin:$PATH" pnpm rebuild better-sqlite3');
  console.error(err);
}

try {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.close();
  console.log(
    `[runtime-preflight] native modules OK (${process.execPath} ${process.version}, modules=${process.versions.modules})`,
  );
} catch (err) {
  printNativeModuleFailure(err);
  process.exit(1);
}

const permissionProbePath =
  process.env.CAT_CAFE_PERMISSION_PROBE_PATH ?? join(homedir(), 'Documents/03 life/AI design/产品项目');

try {
  await access(permissionProbePath, constants.R_OK);
  console.log(`[runtime-preflight] permission probe OK: ${permissionProbePath}`);
} catch (err) {
  console.warn(`[runtime-preflight] permission probe warning: cannot read ${permissionProbePath}`);
  console.warn(
    '[runtime-preflight] If project files under Documents fail with EPERM, grant Full Disk Access to $HOME/.uclaw/node/bin/node.',
  );
  console.warn(err);
}
