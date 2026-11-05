import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {optimize} from 'svgo';
import {Resvg} from '@resvg/resvg-js';
const exec=promisify(execFile);
export async function discoverAdapters(){
  const candidates=process.platform==='win32'?['C:\\Program Files\\Inkscape\\bin\\inkscape.exe','inkscape.exe']:['inkscape'];
  for(const executable of candidates){try{const {stdout}=await exec(executable,['--version'],{timeout:10000,windowsHide:true});if(/Inkscape \d/.test(stdout))return {inkscape:{available:true,executable,version:stdout.trim()},illustrator:{available:false,reason:'Native Illustrator automation is not implemented in this release'},blender:{available:false,reason:'External render adapters are not implemented'},python:{available:false,reason:'External render adapters are not implemented'}};}catch{}}
  return {inkscape:{available:false,reason:'Inkscape executable/version probe failed'},illustrator:{available:false,reason:'Native Illustrator automation is not implemented in this release'},blender:{available:false,reason:'External render adapters are not implemented'},python:{available:false,reason:'External render adapters are not implemented'}};
}
export async function exportVector(source,destination,{eps=false,stock=false,adapters}={}){
  if(path.extname(source).toLowerCase()!=='.svg')throw new Error('Native vector export requires a standalone SVG source. Raster screenshots are never vectorized.');
  const text=await fs.readFile(source,'utf8');
  if(!/<svg[\s>]/i.test(text)||!/<(path|rect|circle|ellipse|polygon|polyline|line|text|use)[\s>]/i.test(text))throw new Error('SVG contains no recognized editable geometry');
  if(/<!DOCTYPE|<!ENTITY|<script|<foreignObject|<image|(?:href|url)\s*[=(]\s*["']?\s*(?:https?:|file:|\/\/)/i.test(text))throw new Error('Vector export rejects scripts, external resources, embedded raster images, foreignObject and XML entities. Make a self-contained vector SVG.');
  const svg=optimize(text,{plugins:['removeComments']}).data;
  const renderer=new Resvg(svg,{fitTo:{mode:'width',value:256},font:{loadSystemFonts:true}});renderer.render().asPng();
  const width=renderer.width,height=renderer.height;
  if(stock&&(width*height<15e6||width*height>65e6))throw new Error('Vector Stock mode requires a 15–65 MP artboard. Source dimensions are preserved.');
  const name=path.basename(source,'.svg').replace(/[^a-zA-Z0-9_-]/g,'_')+'-'+crypto.randomUUID().slice(0,8);
  const target=path.join(await fs.realpath(destination),name+(eps?'.eps':'.svg'));
  if(!eps){await fs.writeFile(target,svg,{flag:'wx'});return {output:target,kind:'Native editable SVG',width,height,warnings:['Text may depend on local fonts. Automated checks do not guarantee Stock acceptance.']};}
  if(!adapters?.inkscape.available)throw new Error('Inkscape adapter unavailable');
  if(/<(filter|mask)|opacity\s*=|rgba\(/i.test(svg))throw new Error('EPS cannot reliably preserve filters, masks or transparency; export SVG instead');
  const temp=path.join(await fs.realpath(destination),'.uvrs-'+crypto.randomUUID()+'.svg');
  try{await fs.writeFile(temp,svg,{flag:'wx'});await exec(adapters.inkscape.executable,[temp,'--export-type=eps','--export-text-to-path','--export-filename='+target],{timeout:60000,windowsHide:true});const output=await fs.readFile(target);if(!output.subarray(0,80).toString().includes('EPSF'))throw new Error('Inkscape output is not valid EPS');return {output:target,kind:'Converted vector EPS',warnings:['Text converted to outlines. Review appearance and editable structure in a vector editor.']};}
  catch(e){await fs.unlink(target).catch(()=>{});throw e;}finally{await fs.unlink(temp).catch(()=>{});}
}
