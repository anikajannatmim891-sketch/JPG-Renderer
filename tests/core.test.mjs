import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {contained,inspectProject} from '../src/core/project.mjs';
import {defaults,validateSettings,inspectRaster} from '../src/core/validation.mjs';
import {DatabaseSync} from 'node:sqlite';
import {viewportFor,planDimensions,filenameHints} from '../src/core/dimensions.mjs';
import {RenderQueue} from '../src/core/queue.mjs';
import {exportVector,discoverAdapters} from '../src/core/vector.mjs';
test('Stock validates real bounds, formats and transparency',()=>{assert.throws(()=>validateSettings({...defaults,width:1920,height:1080,stock:true}),/4–100/);assert.throws(()=>validateSettings({...defaults,width:12000,height:12000,stock:true}),/4–100/);assert.throws(()=>validateSettings({...defaults,stock:true,format:'webp'}),/JPEG/);assert.throws(()=>validateSettings({...defaults,transparent:true}),/JPEG/);validateSettings({...defaults,stock:true});});
test('asset containment denies traversal and symlinks',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'uvrs-'));try{await assert.rejects(contained(root,'../'),/escapes/);await fs.symlink(os.tmpdir(),path.join(root,'escape'),process.platform==='win32'?'junction':'dir');await assert.rejects(contained(root,'escape'),/escapes/);}finally{await fs.rm(root,{recursive:true,force:true});}});
test('manifest build scripts cannot execute implicitly',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'uvrs-'));try{await fs.writeFile(path.join(root,'index.html'),'<html/>');await fs.writeFile(path.join(root,'render-studio.json'),JSON.stringify({buildCommand:'touch unsafe'}));await assert.rejects(inspectProject(root),/not executed/);}finally{await fs.rm(root,{recursive:true,force:true});}});
test('decode validator detects >45MB, alpha, mismatch and duplicates',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'uvrs-'));try{const file=path.join(root,'test.png');await sharp({create:{width:100,height:100,channels:4,background:{r:200,g:100,b:20,alpha:.5}}}).withIccProfile('srgb').png().toFile(file);let s={...defaults,width:100,height:100,transparent:true,format:'png'};const a=await inspectRaster(file,s);assert.equal(a.errors.length,0);assert(a.alphaRange[0]<255);const b=await inspectRaster(file,s,[a]);assert(b.warnings.some(w=>w.includes('Exact duplicate')));await fs.appendFile(file,Buffer.alloc(45_000_001));const c=await inspectRaster(file,{...s,stock:true,width:101});assert(c.errors.some(e=>e.includes('45 MB')));assert(c.errors.some(e=>e.includes('mismatch')));}finally{await fs.rm(root,{recursive:true,force:true});}});
test('queue cancellation, failure, recovery and serialized success',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'uvrs-'));let active=0,max=0;const renderer=async({source,signal})=>{active++;max=Math.max(max,active);try{if(source==='wait')await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Cancelled')),{once:true}));if(source==='fail')throw new Error('fixture failure');return {validation:{hash:source}};}finally{active--;}};try{const q=await new RenderQueue(root,()=>{},renderer).init();const id=await q.add({source:'wait'});while(q.jobs[0].status!=='running')await new Promise(r=>setImmediate(r));await q.add({source:'fail'});await q.add({source:'good'});await q.cancel(id);while(q.active||q.jobs.some(j=>j.status==='queued'))await new Promise(r=>setTimeout(r,5));assert.deepEqual(q.jobs.map(j=>j.status),['cancelled','failed','completed']);assert.equal(max,1);await q.shutdown();const db=new DatabaseSync(path.join(root,'production.sqlite'));db.prepare('INSERT INTO jobs VALUES (?,?)').run('abandoned',JSON.stringify({id:'abandoned',status:'running',input:{source:'recovered'},progress:[],attempts:0}));db.close();const restored=await new RenderQueue(root,()=>{},renderer).init();assert.equal(restored.jobs.at(-1).interrupted,true);while(restored.active||restored.jobs.some(j=>j.status==='queued'))await new Promise(r=>setTimeout(r,5));assert.equal(restored.jobs.at(-1).status,'completed');await restored.shutdown();}finally{await fs.rm(root,{recursive:true,force:true});}});
test('genuine SVG retains editable paths and groups; adapters report availability',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'uvrs-'));try{const out=await exportVector(path.resolve('tests/fixtures/vector.svg'),root,{stock:true});const text=await fs.readFile(out.output,'utf8');assert.match(text,/<path/);assert.match(text,/<g /);assert.match(text,/<linearGradient/);const a=await discoverAdapters();assert.equal(a.illustrator.available,false);assert.equal(typeof a.inkscape.available,'boolean');}finally{await fs.rm(root,{recursive:true,force:true});}});

test('exact dimensions preserve portrait and panorama ratios and cap a 10K Adobe square',()=>{
  assert.deepEqual(planDimensions(1000,1000),{width:10000,height:10000,designWidth:1000,designHeight:1000});
  for(const [w,h] of [[2400,1000],[1000,1480],[2944,1512],[1600,320],[1280,1600]]) {
    const plan=planDimensions(w,h);
    assert.deepEqual(viewportFor(plan),{cssWidth:w,cssHeight:h,ratio:plan.width/w});
    assert.equal(plan.width*h,plan.height*w);
  }
  assert.deepEqual(filenameHints('subject_W1280_10K-8192x10240.html'),{width:1280,height:1600,source:'filename hint'});
  assert.deepEqual(filenameHints('subject__css2400x1000__10k10200x4250.html'),{width:2400,height:1000,source:'filename hint'});
  assert.throws(()=>viewportFor({designWidth:1920,width:4000,height:1701}),/same aspect/);
});
