import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {probeMetadataTool} from '../src/core/metadata-tool.mjs';
const require=createRequire(import.meta.url);
const name=process.platform==='win32'?'exiftool-vendored.exe':'exiftool-vendored.pl';
const root=path.dirname(require.resolve(name+'/package.json'));
const target=path.resolve('vendor/exiftool');await fs.mkdir(target,{recursive:true});
await fs.cp(path.join(root,'bin'),target,{recursive:true});
await fs.copyFile(path.join(root,'LICENSE'),path.join(target,'VENDORED-LICENSE.txt'));
await fs.copyFile(path.join(root,'README.md'),path.join(target,'VENDORED-README.md'));
try{await fs.cp(path.join(root,'patches'),path.join(target,'VENDOR-PATCHES'),{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}
if(process.platform==='win32'){
 await fs.access(path.join(target,'exiftool.exe'));
 // The modern official Windows distribution is not a single executable.
 await fs.access(path.join(target,'exiftool_files'));
}
const previous=process.env.UVRS_EXIFTOOL;process.env.UVRS_EXIFTOOL=path.join(target,process.platform==='win32'?'exiftool.exe':'exiftool');
const result=await probeMetadataTool();if(previous===undefined)delete process.env.UVRS_EXIFTOOL;else process.env.UVRS_EXIFTOOL=previous;
if(!result.available)throw new Error('Prepared ExifTool failed to launch: '+result.error);
await fs.writeFile(path.join(target,'UVRS-distribution.json'),JSON.stringify({package:name,version:JSON.parse(await fs.readFile(path.join(root,'package.json'))).version,probe:result},null,2));
console.log('Prepared complete ExifTool distribution:',target,result);
