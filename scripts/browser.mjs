import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
if(process.argv[2]==='win'&&process.platform!=='win32')throw new Error('Run Windows packaging on Windows (see GitHub Actions)');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
execFileSync(process.execPath,[path.join(path.dirname(require.resolve('playwright/package.json')),'cli.js'),'install','chromium','--no-shell'],{stdio:'inherit',env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:path.join(root,'vendor/chromium')}});
console.log('Pinned Chromium installed in vendor/chromium. Use PLAYWRIGHT_BROWSERS_PATH='+path.join(root,'vendor/chromium')+' for source tests.');
