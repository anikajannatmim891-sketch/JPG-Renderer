import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import crypto from 'node:crypto';
import {pipeline} from 'node:stream/promises';
const require=createRequire(import.meta.url),exec=promisify(execFile);
// libvips file handles must not remain cached while ExifTool replaces files on Windows.
sharp.cache({files:0});
export function exiftoolPath(){
  if(process.env.UVRS_EXIFTOOL)return process.env.UVRS_EXIFTOOL;
  const name=process.platform==='win32'?'exiftool-vendored.exe':'exiftool-vendored.pl';
  return path.join(path.dirname(require.resolve(name+'/package.json')),'bin',process.platform==='win32'?'exiftool.exe':'exiftool');
}
export async function runExiftool(args,{signal}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'uvrs-exif-'));
  try{
    // UTF-8 argument files avoid shell interpolation, Windows command-line limits,
    // ANSI argv conversion, and filenames beginning with a dash.
    if(args.some(a=>typeof a!=='string'||/[\r\n\0]/.test(a)))throw new Error('Invalid ExifTool argument');
    const file=path.join(directory,'arguments.txt');await fs.writeFile(file,args.join('\n')+'\n','utf8');
    const tool=exiftoolPath();
    const command=process.platform==='win32'?tool:'perl';
    const leading=process.platform==='win32'?[]:[tool];
    return await exec(command,[...leading,'-charset','filename=UTF8','-@',file],{windowsHide:true,timeout:120000,maxBuffer:4_000_000,encoding:'utf8',signal});
  }finally{await fs.rm(directory,{recursive:true,force:true});}
}
export async function probeMetadataTool(){try{const {stdout}=await runExiftool(['-ver']);return {available:true,version:stdout.trim()};}catch(e){return {available:false,error:e.message};}}
export async function readEmbeddedMetadata(file){
  const {stdout}=await runExiftool(['-json','-G1','-s','-n','-XMP-dc:Title','-XMP-dc:Description','-XMP-dc:Subject','-XMP-xmp:Rating','-IPTC:Caption-Abstract','-IPTC:Keywords','-IPTC:ObjectName','-IPTC:Headline','-IPTC:CodedCharacterSet',file]);
  const tags=JSON.parse(stdout)[0];if(tags.Error)throw new Error(tags.Error);
  const list=tags['XMP-dc:Subject'];
  return {title:tags['XMP-dc:Title']??'',description:tags['XMP-dc:Description']??'',keywords:Array.isArray(list)?list:list===undefined?[]:[list],rating:tags['XMP-xmp:Rating'],tags};
}
export async function pixelDigest(file){const hash=crypto.createHash('sha256');await pipeline(sharp(file,{limitInputPixels:300e6}).ensureAlpha().raw(),hash);return hash.digest('hex');}
export async function embedAndVerify(file,metadata,{format,signal}={}){
  const intended=metadata.value;
  if(!metadata.complete)throw new Error('Metadata incomplete: '+metadata.errors.join('; '));
  const before=await pixelDigest(file);
  const resolvedFile=await fs.realpath(file);
  const canonicalFile=process.platform==='win32'?resolvedFile.replaceAll('\\','/'):resolvedFile;
  const tags={SourceFile:canonicalFile,'XMP-dc:Title':intended.title,'XMP-dc:Description':intended.description,'XMP-dc:Subject':intended.keywords,'XMP-xmp:Rating':intended.rating};
  const warnings=[...metadata.warnings],legacy=[];
  if(format==='jpeg'){
    tags['IPTC:CodedCharacterSet']='UTF8';
    if(Buffer.byteLength(intended.description,'utf8')<=2000){tags['IPTC:Caption-Abstract']=intended.description;legacy.push('Caption-Abstract');}else warnings.push('Description exceeds IPTC 2000-byte limit; retained in XMP only');
    if(intended.keywords.every(k=>Buffer.byteLength(k,'utf8')<=64)){tags['IPTC:Keywords']=intended.keywords;legacy.push('Keywords');}else warnings.push('A keyword exceeds IPTC 64-byte limit; ordered keywords retained in XMP only');
    if(Buffer.byteLength(intended.title,'utf8')<=64){tags['IPTC:ObjectName']=intended.title;legacy.push('ObjectName');}
    if(Buffer.byteLength(intended.title,'utf8')<=256){tags['IPTC:Headline']=intended.title;legacy.push('Headline');}else warnings.push('Title exceeds IPTC headline limit; retained in XMP only');
  }
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'uvrs-tags-'));
  let writer;
  try{const json=path.join(folder,'metadata.json');await fs.writeFile(json,JSON.stringify([tags]),'utf8');writer=await runExiftool(['-overwrite_original','-charset','IPTC=UTF8','-json='+json,canonicalFile],{signal});}
  finally{await fs.rm(folder,{recursive:true,force:true});}
  if(!(writer.stdout+'\n'+writer.stderr).includes('1 image files updated'))throw new Error('ExifTool did not confirm an updated image: '+writer.stdout+writer.stderr);
  const messages=writer.stderr.split('\n').filter(line=>line.trim()&&!/image files (updated|unchanged)/.test(line));if(messages.length)warnings.push(messages.join('\n'));
  // A fresh process independently reopens the actual image. No writer response is
  // used as proof that a tag survived.
  const actual=await readEmbeddedMetadata(file);
  for(const key of ['title','description','rating'])if(actual[key]!==intended[key])throw new Error(`Metadata readback mismatch: ${key}`);
  if(actual.keywords.length!==intended.keywords.length)throw new Error('Metadata readback mismatch: keyword count');
  for(let i=0;i<intended.keywords.length;i++)if(actual.keywords[i]!==intended.keywords[i])throw new Error(`Metadata readback mismatch: keyword ${i+1} (order/content)`);
  for(const field of legacy){const want=field==='Keywords'?intended.keywords:field==='Caption-Abstract'?intended.description:intended.title;let got=actual.tags['IPTC:'+field];if(field==='Keywords'&&!Array.isArray(got))got=got===undefined?[]:[got];if(JSON.stringify(got)!==JSON.stringify(want))throw new Error('IPTC readback mismatch: '+field);}
  const after=await pixelDigest(file);if(before!==after)throw new Error('Pixel data changed during metadata embedding');
  return {status:'verified',complete:true,intended,readback:actual,sources:metadata.sources,warnings,pixelDigest:after,legacyFields:legacy,keywordOrderVerified:true};
}
