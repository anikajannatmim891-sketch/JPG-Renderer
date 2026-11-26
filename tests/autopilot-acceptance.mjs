import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {renderArtwork} from '../src/core/render.mjs';
import {RenderQueue,autopilotDefaults,scanFolder,sourceDigest} from '../src/core/queue.mjs';
import {readEmbeddedMetadata} from '../src/core/metadata-tool.mjs';

const root = path.resolve(process.env.UVRS_AUTOPILOT_OUTPUT || 'test-output/autopilot');
await fs.mkdir(root,{recursive:true});
const runDirectory = await fs.mkdtemp(path.join(root,'run-'));
const images = path.join(runDirectory,'images');
const fixtures = path.join(runDirectory,'sources');
await fs.mkdir(images);
await fs.mkdir(fixtures);
const source = name=>path.resolve('tests/fixtures',name);
const verification = [];
let failed = 0;
async function run(name,execute) {
  console.log('START',name);
  try {
    verification.push({name,status:'passed',evidence:await execute()});
    console.log('PASS',name);
  } catch (error) {
    failed++;
    verification.push({name,status:'failed',error:error.stack});
    console.error('FAIL',name,error.stack);
  }
  await fs.writeFile(path.join(runDirectory,'acceptance.json'),JSON.stringify(verification,null,2));
}
async function render(file,preset,settings={}) {
  const hash = await sourceDigest(file);
  const result = await renderArtwork({source:file,destination:images,autopilot:{...autopilotDefaults,preset},settings,
    writeManifest:false,onProgress:event=>{if(event.phase==='fallback')console.log('  recovery:',event.message);}});
  assert.equal(await sourceDigest(file),hash);
  assert.equal(result.metadata.status,'verified');
  assert(result.validation.srgb);
  const decoded = await sharp(result.output,{limitInputPixels:100e6}).metadata();
  assert.equal(decoded.width,result.actual.width);
  assert.equal(decoded.height,result.actual.height);
  assert.equal(decoded.chromaSubsampling,'4:4:4');
  assert.equal(result.detected.width*decoded.height,result.detected.height*decoded.width);
  return result;
}

await run('10K Japanese portrait and numeric keywords in actual XMP and IPTC',async()=>{
  const r = await render(source('greeting-card.html'),'10K');
  assert.deepEqual(r.actual,{width:6925,height:10249});
  const expected = ['gold','賀正','new-year','2027','2026','007','2028','24','100%','365','new year','2027 calendar','বাংলা'];
  const read = await readEmbeddedMetadata(r.output);
  assert.deepEqual(read.keywords,expected);
  assert.deepEqual(read.tags['IPTC:Keywords'],expected);
  assert.equal(read.rating,5);
  assert.equal(read.title,'賀正 2027');
  return {output:r.output,actual:r.actual,detected:r.detected,read};
});

await run('2400 × 1000 legacy fixed-coordinate Canvas 2D at 8K and 10K',async()=>{
  const fixed = path.join(fixtures,'arcs__css1920x1080__10k10240x5760.html');
  await fs.copyFile(source('legacy-canvas.html'),fixed);
  for (const preset of ['8K','10K']) {
    const r = await render(fixed,preset);
    assert.equal(r.detected.width,2400);
    assert.equal(r.detected.height,1000);
    assert.match(r.detected.notes.join(' '),/over filename hint/);
    assert.equal(r.strategy,'fixed Canvas 2D');
    assert(r.recovered);
  }
});

await run('100 MP square, standalone SVG and responsive portrait filename',async()=>{
  const square = path.join(fixtures,'square.html');
  const assets = path.join(fixtures,'svg');
  await fs.mkdir(assets);
  const vector = path.join(assets,'art.svg');
  const portrait = path.join(fixtures,'responsive_W1280_10K-8192x10240.html');
  const gradient = '<!doctype html><title>Gradients</title><meta name="description" content="Banded colors"><meta name="keywords" content="2027,gradient,paper"><style>html,body{margin:0}article{background:linear-gradient(137deg,#152439,#69a7b7,#e5a673)}';
  await fs.writeFile(square,gradient+'article{width:1000px;height:1000px}</style><article id=artwork></article>');
  await fs.writeFile(portrait,gradient+'article{width:100vw;height:100vh}</style><article id=artwork></article>');
  await fs.copyFile(source('vector.svg'),vector);
  await fs.writeFile(path.join(assets,'render-studio.json'),JSON.stringify({metadata:{title:'Vector shapes',description:'Drawn paths and gradients',keywords:['path','2027','007']}}));
  assert.deepEqual((await render(square,'10K')).actual,{width:10000,height:10000});
  const r = await render(vector,'8K');
  assert.match(r.backend,/SVG/);
  assert.equal((await render(portrait,'4K')).detected.source,'filename hint');
  return {svg:r.actual,square:{width:10000,height:10000}};
});

await run('8K legacy fullscreen shader tiles, optimized-out uniform, full-image coordinates and orientation',async()=>{
  const r = await render(source('legacy-fullscreen.html'),'8K');
  assert.equal(r.strategy,'tiled fullscreen WebGL');
  assert(r.recovered);
  assert(r.gpu.webgl2);
  const {width,height} = r.actual;
  const px = async (left,top)=>sharp(r.output).extract({left,top,width:1,height:1}).raw().toBuffer();
  const [tl,tr,bl,br] = await Promise.all([px(3,3),px(width-4,3),px(3,height-4),px(width-4,height-4)]);
  assert(tr[0]-tl[0]>170 && br[0]-bl[0]>170);
  assert(tl[1]-bl[1]>170 && tr[1]-br[1]>170);
  for (const x of [3072,6144]) {
    const [left,right] = await Promise.all([px(x-1,Math.round(height*.35)),px(x,Math.round(height*.35))]);
    assert(left.every((v,i)=>Math.abs(v-right[i])<=4),'vertical seam at '+x);
  }
  return {output:r.output,actual:r.actual,gpu:r.gpu};
});

await run('Black and partial high-DPR frames recover using the verified tile contract',async()=>{
  const input = await fs.readFile(source('tiles.html'),'utf8');
  for (const mode of ['black','partial']) {
    const file = path.join(fixtures,mode+'__css1920x1080.html');
    const paint = mode==='black' ? '#000' : '#132d48';
    const changed = input.replace('g.translate',`if(!tile && pixelRatio>1){g.fillStyle='${paint}';g.fillRect(0,0,width,height);
      ${mode==='partial' ? "g.fillStyle='#dda';g.fillRect(0,0,width/2,height/2);" : ''}
      return;}g.translate`);
    const metadata = '<title>Grid tiles</title><meta name="description" content="A geometric grid"><meta name="keywords" content="2027,grid,tiles">';
    await fs.writeFile(file,metadata+changed);
    const r = await render(file,'4K');
    assert.equal(r.strategy,'tiled contract');
    assert(r.recovered);
    assert(r.logs.some(log=>log.level==='fallback' && /entirely black|uniform region/.test(log.message)));
  }
});

await run('Native stock-size React and Three.js camera-offset tiles',async()=>{
  const folder = path.join(fixtures,'bundled');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder,'render-studio.json'),JSON.stringify({designWidth:1920,designHeight:1080,
    metadata:{title:'Studio rendering',description:'Color and sculptural geometry',keywords:['studio','2027','007']}}));
  const react = path.join(folder,'react.tsx');
  await fs.copyFile(source('react.tsx'),react);
  const dom = await render(react,'4K');
  assert.equal(dom.backend,'React / DOM');
  const three = path.join(folder,'three.ts');
  const scene = (await fs.readFile(source('three.ts'),'utf8'))
    .replace('version:1,render({width,height,pixelRatio,time})','version:1,threeCamera:camera,capabilities:{tiles:true,threeViewOffset:true},render({width,height,pixelRatio,time,tile})')
    .replace('renderer.setSize(width/pixelRatio,height/pixelRatio);',
      'renderer.setSize((tile?.width ?? width)/pixelRatio,(tile?.height ?? height)/pixelRatio);if(!tile && pixelRatio>1){renderer.setSize(1,1);return;}');
  await fs.writeFile(three,scene);
  const model = await render(three,'4K');
  assert.equal(model.strategy,'tiled contract');
  assert.equal(model.backend,'Three.js / WebGL');
  return {react:dom.actual,three:model.actual,gpu:model.gpu};
});

const idle = async queue => {
  const deadline = Date.now() + (process.env.UVRS_FULL_BATCH ? 1_500_000 : 300_000);
  while (queue.active || (!queue.paused && queue.jobs.some(j=>j.status==='queued'))) {
    if (Date.now()>deadline) throw new Error('Queue exceeded acceptance timeout');
    await new Promise(resolve=>setTimeout(resolve,30));
  }
};

await run('200-entry SQLite batch, deduplication, pause, restart, and clean output',async()=>{
  const folder = path.join(runDirectory,'200-artworks');
  const database = path.join(runDirectory,'batch-database');
  const completed = path.join(runDirectory,'batch-images');
  await Promise.all([fs.mkdir(folder),fs.mkdir(completed)]);
  const base = '<!doctype html><title>Batch gradients</title><meta name=description content="A gradient test pattern">' +
    '<meta name=keywords content="2027,007,gradients"><style>html,body{margin:0}main{width:200px;height:200px;' +
    'background:linear-gradient(140deg,#15253d,#c98d70,#8adbbc);display:grid;place-items:center;color:#ffeacb;font:30px serif}</style>';
  for (let i=0;i<200;i++) {
    const file = path.join(folder,String(i).padStart(3,'0')+'.html');
    const markup = i===0 ? '<main id="artwork" style="width:1000px;height:1480px"></main><script>throw new Error("broken test entry")</script>' :
      base + '<main id=artwork>' + i + '</main>';
    await fs.writeFile(file,markup);
  }
  const files = await scanFolder(folder,false);
  let queue = await new RenderQueue(database).init();
  try {
    assert.deepEqual(await queue.importFiles([...files,files[1]]),{added:200,duplicates:1,errors:[]});
    assert.equal(queue.start({...autopilotDefaults,preset:'custom',customEdge:2000},completed),200);
    await queue.control('pause');
    await idle(queue);
    assert.equal(queue.jobs[0].status,'failed');
    assert.equal(queue.jobs.filter(j=>j.status==='queued').length,199);
    await queue.shutdown();
    queue = await new RenderQueue(database).init();
    assert.equal(queue.jobs.length,200);
    assert.equal(queue.paused,true);
    for (const job of queue.jobs.slice(3)) await queue.control('pause',job.id);
    await queue.control('resume',queue.jobs[1].id);
    await queue.control('resume',queue.jobs[2].id);
    queue.setPaused(false);
    void queue.pump();
    await idle(queue);
    assert.deepEqual(queue.jobs.slice(0,3).map(j=>j.status),['failed','completed','completed']);
    assert.equal(queue.jobs.filter(j=>j.status==='paused').length,197);
    assert.equal((await fs.readdir(completed)).length,2);
    assert((await fs.readdir(completed)).every(file=>file.endsWith('.jpg')));
    const completedJob=queue.jobs[1];
    await queue.control('remove',completedJob.id);
    await fs.access(completedJob.result.output);
    if (process.env.UVRS_FULL_BATCH) {
      await queue.control('resume');
      await idle(queue);
      const errors = queue.jobs.slice(1).filter(j=>j.status!=='completed');
      assert.deepEqual(errors.map(j=>[j.input.source,j.error]),[]);
      assert.equal((await fs.readdir(completed)).length,199);
      return {imported:200,persistedAcrossRestart:200,rendered:199,invalid:1};
    }
    return {imported:200,persistedAcrossRestart:200,rendered:2,invalid:1,paused:197};
  } finally {await queue.shutdown();}
});

await run('Transient ExifTool error retries metadata only and cancellation cleans its checkpoint',async()=>{
  const database = path.join(runDirectory,'retry-database');
  const out = path.join(runDirectory,'retry-images');
  await fs.mkdir(out);
  const oldExif = process.env.UVRS_EXIFTOOL;
  let injected = false, retried = false;
  const restore = () => {
    if (oldExif===undefined) delete process.env.UVRS_EXIFTOOL;
    else process.env.UVRS_EXIFTOOL=oldExif;
  };
  const queue = await new RenderQueue(database,jobs=>{
    const job = jobs[0];
    if (job?.status==='running' && job.progress.at(-1)?.phase==='metadata' && !injected) {
      injected = true;
      process.env.UVRS_EXIFTOOL=path.join(runDirectory,'missing-exiftool.exe');
    }
    if (job?.status==='queued' && job.recovery && injected) {retried=true;restore();}
  }).init();
  try {
    await queue.importFiles([source('greeting-card.html')]);
    queue.start({...autopilotDefaults,preset:'4K'},out);
    await idle(queue);
    assert(injected && retried);
    assert.equal(queue.jobs[0].status,'completed',queue.jobs[0].error);
    assert.equal(queue.jobs[0].attempts,2);
    assert(queue.jobs[0].result.logs.some(log=>log.message.includes('source was not rendered again')));
    assert.equal((await fs.readdir(out)).length,1);
    const cancel = path.join(fixtures,'cancel__css1920x1080.html');
    await fs.writeFile(cancel,'<!doctype html><script>window.renderStudio={version:1,ready:new Promise(()=>{}),render(){}}</script>');
    await queue.importFiles([cancel]);
    queue.start(autopilotDefaults,out);
    await queue.cancel(queue.jobs[1].id);
    await idle(queue);
    assert.equal(queue.jobs[1].status,'cancelled');
    assert.deepEqual(await fs.readdir(queue.workspace),[]);
    return {attempts:2,completed:1,cancelled:1};
  } finally {restore();await queue.shutdown();}
});

if (failed) process.exitCode=1;
