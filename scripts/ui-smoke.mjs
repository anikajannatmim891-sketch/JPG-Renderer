import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {readEmbeddedMetadata} from '../src/core/metadata-tool.mjs';
const evidence=path.resolve('test-output/ui-metadata');await fs.mkdir(evidence,{recursive:true});
const external=await fs.mkdtemp(path.join(os.tmpdir(),'UVRS smoke 金色 '));
await fs.cp(path.resolve('tests/fixtures'),path.join(external,'artwork source'),{recursive:true});
const out=path.join(external,'output files');await fs.mkdir(out);
const executablePath=process.env.UVRS_APP_EXECUTABLE||undefined;
const args=executablePath?[]:['.'];if(process.platform==='linux'&&!process.env.DISPLAY)args.push('--ozone-platform=headless');
const profile=path.join(external,'user profile');
const env={...process.env,UVRS_CHROMIUM:executablePath?'':process.env.UVRS_CHROMIUM||'',UVRS_EXIFTOOL:'',UVRS_SOFTWARE_TEST:'1',UVRS_TEST_USER_DATA:profile};
const app=await electron.launch({executablePath,args,cwd:executablePath?external:process.cwd(),env,timeout:60000});
const records=[];
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.getByText('Your source. Every pixel.').waitFor();
 const runtime=await app.evaluate(({app})=>({packaged:app.isPackaged,resources:process.resourcesPath,chromium:process.env.UVRS_CHROMIUM,exiftool:process.env.UVRS_EXIFTOOL,esbuild:process.env.ESBUILD_BINARY_PATH}));
 if(executablePath){assert.equal(runtime.packaged,true);for(const k of ['chromium','exiftool','esbuild']){assert(runtime[k]?.startsWith(runtime.resources),`${k} must come from installed resources`);await fs.access(runtime[k]);}}
 const source=path.join(external,'artwork source','metadata.html');
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},source);
 await page.getByRole('button',{name:'Open artwork',exact:true}).first().click();
 await page.getByText('metadata.html',{exact:true}).first().waitFor();
 const expected=JSON.parse(await fs.readFile('tests/fixtures/metadata-expected.json','utf8'));
 assert.equal(await page.getByLabel('Metadata title',{exact:true}).inputValue(),expected.title);
 assert.equal(await page.getByLabel('Metadata rating',{exact:true}).inputValue(),'5');
 const editedTitle='Manually edited gold — 金色';await page.getByLabel('Metadata title',{exact:true}).fill(editedTitle);
 await app.evaluate(({dialog},dest)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dest]});},out);
 await page.locator('button.destination').click();
 async function waitJob(id,timeout=240000){const until=Date.now()+timeout;while(Date.now()<until){const state=await page.evaluate(()=>window.studio.call('state'));const j=state.jobs.find(j=>j.id===id);if(j&&['completed','failed','cancelled'].includes(j.status))return j;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out waiting for render job '+id);}
 async function exportAndWait(label){const previous=(await page.evaluate(()=>window.studio.call('state'))).jobs.map(j=>j.id);await page.getByRole('button',{name:'Queue full-resolution export'}).click();let id;const until=Date.now()+15000;while(!id&&Date.now()<until){const state=await page.evaluate(()=>window.studio.call('state'));id=state.jobs.find(j=>!previous.includes(j.id))?.id;if(!id)await new Promise(r=>setTimeout(r,50));}assert(id,'Click did not enqueue a new job');const job=await waitJob(id);assert.equal(job.status,'completed',job.error);assert.equal(job.result.metadata.status,'verified');const read=await readEmbeddedMetadata(job.result.output);assert.equal(read.rating,5);assert.deepEqual(read.keywords,expected.keywords);records.push({label,output:job.result.output,actual:job.result.actual,metadata:read});return job;}
 const job=await exportAndWait('HTML import, manual edit, JPEG metadata');
 assert.equal(job.result.actual.width,3840);assert.equal(job.result.actual.height,2160);assert.equal((await readEmbeddedMetadata(job.result.output)).title,editedTitle);
 await page.getByAltText('Rendered artwork preview').waitFor();
 await page.getByRole('button',{name:'1:1',exact:true}).click();await page.getByRole('button',{name:'Fit',exact:true}).click();
 await page.locator('aside').evaluate(el=>el.scrollTop=0);await page.screenshot({path:path.join(evidence,'desktop.png')});
 // Browser protocol injects an actual local-file drag payload, not an artificial
 // File object whose path would be absent in Electron's webUtils.
 const session=await page.context().newCDPSession(page);
 const dropFile=path.join(external,'artwork source','metadata-transparent.html');
 const data={items:[],files:[dropFile],dragOperationsMask:1};
 for(const type of ['dragEnter','dragOver','drop'])await session.send('Input.dispatchDragEvent',{type,x:350,y:270,data});
 await page.getByText('metadata-transparent.html',{exact:true}).first().waitFor({timeout:15000});
 await page.getByLabel('Preserve transparency').check();
 const png=await exportAndWait('Real file drag/drop and transparent PNG metadata');
 assert.equal(png.result.validation.alphaRange[0],0);assert.equal(png.result.validation.alphaRange[1],255);assert.equal((await readEmbeddedMetadata(png.result.output)).title,expected.title);
 await page.getByRole('button',{name:'diagnostics',exact:true}).click();await page.getByRole('heading',{name:'Render diagnostics'}).waitFor();
 await page.screenshot({path:path.join(evidence,'diagnostics.png')});
 await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},path.join(out,'GPU diagnostics.json'));
 await page.getByRole('button',{name:'Save GPU diagnostic report'}).click();await page.waitForFunction(()=>document.body.textContent.includes('GPU report saved:'));
 const report=JSON.parse(await fs.readFile(path.join(out,'GPU diagnostics.json')));assert.equal(report.gpu.software,true);
 // Confirm queue failures cannot prevent a subsequent valid request, without
 // simulating the renderer or metadata writer.
 const waitingFile=path.join(external,'artwork source','waiting.html');await fs.writeFile(waitingFile,'<!doctype html><script>window.renderStudio={version:1,ready:new Promise(()=>{}),render(){}}</script>');
 const waiting=await page.evaluate(source=>window.studio.call('drop',source),waitingFile);
 const waitingId=await page.evaluate(id=>window.studio.call('enqueue',id,{width:1920,height:1080},true),waiting.id);
 await page.locator('.job:has(.status.running)').getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal((await waitJob(waitingId,60000)).status,'cancelled');
 const broken=await page.evaluate(source=>window.studio.call('drop',source),path.join(external,'artwork source','broken.html'));
 const brokenId=await page.evaluate(id=>window.studio.call('enqueue',id,{width:1920,height:1080},true),broken.id);
 assert.equal((await waitJob(brokenId,60000)).status,'failed');
 const good=await page.evaluate(source=>window.studio.call('drop',source),source);
 const nextId=await page.evaluate(id=>window.studio.call('enqueue',id,{width:1920,height:1080},false,{}),good.id);
 const recovered=await waitJob(nextId,120000);assert.equal(recovered.status,'completed',recovered.error);
 if(executablePath){
  // These exports run through the installed UI and bundled tools from an
  // independent working directory, not the source renderer module.
  const cases=[['metadata.html',7680,4320,'jpeg',false,'direct'],['metadata-deterministic.html',10240,5760,'jpeg',false,'tiled'],['metadata-deterministic.html',12288,6912,'jpeg',false,'tiled'],['metadata-transparent.html',7680,4320,'png',true,'direct']];
  for(const [filename,width,height,format,transparent,strategy]of cases){
   await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.join(external,'artwork source',filename));
   await page.getByRole('button',{name:'Open artwork',exact:true}).first().click();
   await page.getByText(filename,{exact:true}).first().waitFor();
   await page.getByLabel('Preserve transparency').setChecked(transparent);
   await page.getByLabel('Format',{exact:true}).selectOption(format);
   await page.getByLabel('Width',{exact:true}).fill(String(width));
   await page.getByLabel('Height',{exact:true}).fill(String(height));
   await page.getByLabel('Rendering path',{exact:true}).selectOption(strategy);
   await page.getByLabel('Adobe Stock technical limits').check();
   const high=await exportAndWait(`Installed native ${width} × ${height} ${format} with metadata`);
   assert.deepEqual(high.result.actual,{width,height});assert.equal(high.result.validation.errors.length,0);
   if(transparent)assert.equal(high.result.validation.alphaRange[0],0);
  }
  for(const name of ['assets.html','react.tsx','three.ts']){
   const p=await page.evaluate(file=>window.studio.call('drop',file),path.join(external,'artwork source',name));
   const id=await page.evaluate(id=>window.studio.call('enqueue',id,{width:1920,height:1080,allowSoftware:true},true),p.id);
   const j=await waitJob(id);assert.equal(j.status,'completed',j.error);
   if(name==='three.ts')assert(j.result.gpu.webgl2);
   records.push({label:'Installed '+name+' local fonts/assets or bundled browser dependency',output:j.result.output,actual:j.result.actual,metadataStatus:j.result.metadata.status});
  }
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.join(external,'artwork source','vector.svg'));
  await page.getByRole('button',{name:'Open artwork',exact:true}).first().click();
  await page.getByRole('button',{name:'Native SVG',exact:true}).click();
  await page.waitForFunction(()=>document.body.textContent.includes('Native editable SVG:'));
  const vectors=(await fs.readdir(out)).filter(f=>f.endsWith('.svg'));assert(vectors.length>0);assert.match(await fs.readFile(path.join(out,vectors[0]),'utf8'),/<path/);
 }
 assert.deepEqual(errors,[]);
 for(const r of records){await fs.copyFile(r.output,path.join(evidence,path.basename(r.output)));await fs.copyFile(r.output+'.json',path.join(evidence,path.basename(r.output)+'.json'));}
 await fs.copyFile(path.join(out,'GPU diagnostics.json'),path.join(evidence,'GPU diagnostics.json'));
 await fs.writeFile(path.join(evidence,'smoke.json'),JSON.stringify({status:'passed',runtime,independentWorkingDirectory:external,records,verified:['import','manual metadata edit','JPEG XMP/IPTC','PNG XMP','default five-star rating','ordered keywords','file drag/drop','real alpha','preview/zoom','GPU report','failed asset recovery','active cancellation']},null,2));
 console.log('PASS desktop UI: source metadata, manual edit, JPEG, real drag/drop, RGBA PNG, readback and failed-job recovery');
}finally{await app.close();}
// Relaunch the same actual executable and profile; no dev server is involved.
const relaunched=await electron.launch({executablePath,args,cwd:executablePath?external:process.cwd(),env,timeout:60000});
try{const page=await relaunched.firstWindow();await page.getByText('Your source. Every pixel.').waitFor();const state=await page.evaluate(()=>window.studio.call('state'));assert(state.jobs.some(j=>j.status==='completed'));console.log('PASS desktop relaunch and persistent queue');}finally{await relaunched.close();}
