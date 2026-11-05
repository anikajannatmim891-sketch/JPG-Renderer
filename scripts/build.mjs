import fs from 'node:fs/promises';
import {build} from 'esbuild';
import {build as viteBuild} from 'vite';
await build({entryPoints:['src/desktop/main.mjs','src/desktop/preload.mjs'],bundle:true,platform:'node',target:'node22',format:'cjs',outdir:'dist/desktop',outExtension:{'.js':'.cjs'},packages:'external',sourcemap:true,define:{'import.meta.url':'__filename'}});
await viteBuild({root:'src/ui',base:'./',build:{outDir:'../../dist/ui',emptyOutDir:true}});

await fs.writeFile('dist/desktop/bootstrap.cjs', `const {app}=require('electron');const path=require('node:path');if(app.isPackaged){process.env.UVRS_BROWSER_DEPENDENCIES=path.join(process.resourcesPath,'app.asar.unpacked','node_modules');process.env.UVRS_EXIFTOOL=path.join(process.resourcesPath,'exiftool','exiftool.exe');process.env.ESBUILD_BINARY_PATH=path.join(process.resourcesPath,'app.asar.unpacked','node_modules','@esbuild','win32-x64','esbuild.exe');}require('./main.cjs');\n`);

await import('./notices.mjs');
