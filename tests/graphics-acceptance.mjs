import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {renderArtwork} from '../src/core/render.mjs';
import {sourceDigest,autopilotDefaults} from '../src/core/queue.mjs';
import {readEmbeddedMetadata} from '../src/core/metadata-tool.mjs';

const evidence=path.resolve('test-output/graphics');
await fs.mkdir(evidence,{recursive:true});
const output=await fs.mkdtemp(path.join(evidence,'run-'));
const fixtures=path.resolve('tests/fixtures/graphics');
const expected=JSON.parse(await fs.readFile(path.join(fixtures,'render-studio.json'))).metadata.keywords;
const results=[];
let failed=false;
async function test(name, fn) {
  if (process.env.UVRS_GRAPHICS_FILTER && !name.match(new RegExp(process.env.UVRS_GRAPHICS_FILTER))) return;
  console.log('START',name);
  try {const evidence=await fn();results.push({name,status:'passed',evidence});console.log('PASS',name);}
  catch(error) {failed=true;results.push({name,status:'failed',error:error.stack});console.error('FAIL',name,error.stack);}
  await fs.writeFile(path.join(output,'acceptance.json'),JSON.stringify(results,null,2));
}
async function verify(result,source,sha) {
  assert.equal(await sourceDigest(source),sha);
  assert.equal(result.metadata.status,'verified');
  const {width,height,icc}=await sharp(result.output).metadata();
  assert.deepEqual(result.actual,{width,height});
  assert.equal(width*540,height*960);
  assert(icc);
  const read=await readEmbeddedMetadata(result.output);
  assert.deepEqual(read.keywords,expected);
  assert.deepEqual(read.tags['IPTC:Keywords'],expected);
  assert.equal(read.rating,5);
  const {data}=await sharp(result.output).resize(8,8,{fit:'fill'}).removeAlpha().raw().toBuffer({resolveWithObject:true});
  assert(Math.max(...data)-Math.min(...data)>30);
  return {actual:result.actual,backend:result.backend,gpu:result.gpu,samples:result.samples,output:result.output};
}
async function render(name,edge=1536,extra={}) {
  const source=path.join(fixtures,name);
  const sha=await sourceDigest(source);
  const result=await renderArtwork({source,destination:output,writeManifest:false,
    autopilot:{...autopilotDefaults,profile:'general',preset:'custom',customEdge:edge,...extra},
    onProgress:e=>{if ([ 'backend','sampling','sampled','fallback'].includes(e.phase)) console.log(e.message);}});
  return {result,report:await verify(result,source,sha)};
}
await test('Babylon.js PBR colonnade with metallic and transparent surfaces, shadows and FXAA',async()=>{
  const {result,report}=await render('babylon.ts',4096);
  assert(result.gpu.webgl2);
  assert.equal(result.actual.width,4096);
  return report;
});
await test('Babylon.js full-camera projection tiles match direct framing',async()=>{
  const source=path.join(fixtures,'babylon.ts');
  const settings={width:1536,height:864,designWidth:960,designHeight:540,allowSoftware:true};
  const execute=strategy=>renderArtwork({source,destination:output,writeManifest:false,settings:{...settings,strategy}});
  const direct=await execute('direct');
  const tiles=await execute('tiled');
  const raw=r=>sharp(r.output).resize(64,36).removeAlpha().raw().toBuffer();
  const [a,b]=await Promise.all([raw(direct),raw(tiles)]);
  const mean=a.reduce((sum,pixel,i)=>sum+Math.abs(pixel-b[i]),0)/a.length;
  assert(mean<8,'Mean pixel delta across Babylon.js tiles: '+mean);
  return {direct:direct.output,tiles:tiles.output,meanDifference:mean};
});
await test('Three.js GPU path tracer waits for convergence before publication',async()=>{
  const {result,report}=await render('pathtrace.ts',960);
  assert.equal(result.samples,3);
  assert(result.gpu.webgl2);
  await assert.rejects(render('pathtrace.ts',960,{sampleLimit:2}),/sample limit/);
  return report;
});
await test('OffscreenCanvas worker completes a native-sized frame',async()=>{
  const {result,report}=await render('worker.html',2048);
  assert.match(result.backend,/OffscreenCanvas/);
  assert.equal(result.actual.width,2048);
  return report;
});
await test('React Three Fiber bundled renderer executes an authored scene',async()=>{
  const {result,report}=await render('fiber.tsx',1920);
  assert(result.gpu.webgl2);
  return report;
});
if (process.env.UVRS_WEBGPU_TEST==='1' || process.env.UVRS_HARDWARE_WEBGPU==='1') {
  await test('WebGPU renders WGSL into a native texture with pixel readback',async()=>{
    const {result,report}=await render('webgpu-texture.html',2048);
    assert(result.gpu.webgpu.operational && result.gpu.webgpu.devices[0].submissions>0);
    assert.match(result.backend,/texture readback/);
    if(result.gpu.software) await assert.rejects(render('webgpu-texture.html',1024,{hardwareOnly:true}),/Hardware-only policy/);
    return report;
  });
}
if (process.env.UVRS_WEBGPU_CANVAS_TEST==='1' || process.env.UVRS_HARDWARE_WEBGPU==='1') {
  await test('WebGPU renders native WGSL with its device and exact tile coordinates',async()=>{
    const {result,report}=await render('webgpu.html',4096);
    assert(result.gpu.webgpu.operational && result.gpu.webgpu.devices[0].submissions>0);
    const settings={width:4096,height:2304,designWidth:960,designHeight:540,strategy:'tiled',allowSoftware:true};
    const source=path.join(fixtures,'webgpu.html');
    const tiled=await renderArtwork({source,destination:output,writeManifest:false,settings});
    const raster=file=>sharp(file).removeAlpha().raw().toBuffer();
    const [direct,tiles]=await Promise.all([raster(result.output),raster(tiled.output)]);
    assert.equal(Buffer.compare(direct,tiles),0,'Native WebGPU tiles must match direct capture pixel for pixel');
    return report;
  });
  await test('Babylon.js WebGPU renders a PBR scene with the bundled engine',async()=>{
    const {result,report}=await render('babylon-webgpu.ts',1536);
    assert(result.gpu.webgpu.operational && result.gpu.webgpu.devices.length);
    return report;
  });
  await test('Three.js WebGPURenderer and TSL resolve exact CDN versions offline',async()=>{
    const {result,report}=await render('tsl.html');
    assert(result.gpu.webgpu.operational && result.gpu.webgpu.devices.length);
    return report;
  });
} else results.push({name:'WebGPU canvas and Three.js TSL',status:'unrun',reason:'Requires a WebGPU compositor. Set UVRS_WEBGPU_CANVAS_TEST=1 or UVRS_HARDWARE_WEBGPU=1.'});
await fs.writeFile(path.join(output,'acceptance.json'),JSON.stringify(results,null,2));
if(failed) process.exitCode=1;
