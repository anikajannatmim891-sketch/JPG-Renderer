import {app,BrowserWindow,ipcMain,dialog,shell} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {RenderQueue,autopilotDefaults,scanFolder,validatePreferences} from '../core/queue.mjs';
import {inspectProject,contained} from '../core/project.mjs';
import {discoverAdapters,exportVector} from '../core/vector.mjs';
import {inspectSourceMetadata,resolveMetadata,metadataDefaults} from '../core/metadata.mjs';
import {probeMetadataTool} from '../core/metadata-tool.mjs';
import {defaults,validateSettings} from '../core/validation.mjs';
if(process.env.UVRS_TEST_USER_DATA)app.setPath('userData',process.env.UVRS_TEST_USER_DATA);
let window,queue,adapters,settingsFile,metadataTool;
let state={settings:defaults,destination:null,history:[],autopilot:autopilotDefaults,metadata:{enabled:true,defaultRating:5,maxKeywords:49}};
const projects=new Map(),destinations=new Set();
let settingsWrite = Promise.resolve();
function save() {
  const value = JSON.stringify(state,null,2);
  settingsWrite = settingsWrite.catch(()=>{}).then(async()=>{
    const temp = settingsFile + '.tmp';
    await fs.writeFile(temp,value);
    await fs.rename(temp,settingsFile);
  });
  return settingsWrite;
}
async function register(source){const project=await inspectProject(source);const id=crypto.randomUUID();project.metadata=await inspectSourceMetadata(project,state.metadata);projects.set(id,project);state.history=[source,...state.history.filter(p=>p!==source)].slice(0,15);await save();const files=[];async function walk(dir,depth=0){if(depth>4)return;for(const e of await fs.readdir(dir,{withFileTypes:true})){if(files.length>=200)return;if(e.name.startsWith('.')||e.name==='node_modules')continue;const file=path.join(dir,e.name);if(e.isDirectory())await walk(file,depth+1);else if(e.isFile())files.push(path.relative(project.root,file));}}await walk(project.root);return {id,name:project.name,entry:project.entry,kind:project.kind,manifest:project.manifest,files,metadata:project.metadata};}
function guard(event){if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('Unauthorized IPC');}
function handle(name,fn){ipcMain.handle(name,async(event,...args)=>{guard(event);try{return {ok:true,value:await fn(...args)};}catch(e){return {ok:false,error:e.message};}});}
const singleInstance = process.env.UVRS_TEST_USER_DATA || app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else app.on('second-instance',()=>{if(window?.isMinimized())window.restore();window?.focus();});
if (singleInstance) app.whenReady().then(async()=>{
  if(app.isPackaged){const browserRoot=path.join(process.resourcesPath,'chromium');const dirs=await fs.readdir(browserRoot);let found;for(const dir of dirs.filter(d=>/^chromium-/.test(d))){for(const rel of ['chrome-win/chrome.exe','chrome-win64/chrome.exe']){const candidate=path.join(browserRoot,dir,rel);try{await fs.access(candidate);found=candidate;}catch{}}}if(!found)throw new Error('Bundled Windows Chromium is missing');process.env.UVRS_CHROMIUM=found;}
  const data=app.getPath('userData');await fs.mkdir(data,{recursive:true});settingsFile=path.join(data,'settings.json');
  try{state={...state,...JSON.parse(await fs.readFile(settingsFile,'utf8'))};}catch(e){if(e.code!=='ENOENT')await fs.copyFile(settingsFile,settingsFile+'.corrupt-'+Date.now());}
  if(state.destination){try{destinations.add(await fs.realpath(state.destination));}catch{state.destination=null;}}
  adapters=await discoverAdapters();metadataTool=await probeMetadataTool();
  queue=await new RenderQueue(data,(jobs,paused)=>{for(const j of jobs)if(j.result)for(const p of projects.values())if(p.file===j.result.source)p.runtimeMetadata=j.result.runtimeMetadata;if(window&&!window.isDestroyed())window.webContents.send('jobs',jobs,paused);}).init();
  handle('state',()=>({...state,adapters,metadataTool,jobs:queue.snapshot(),paused:queue.paused}));
  const filters = [{name:'Artwork',extensions:['html','htm','svg','js','mjs','ts','tsx','jsx']}];
  const validateFiles = files => {
    if (!Array.isArray(files) || files.length > 50000 || files.some(file=>typeof file !== 'string')) throw new Error('Invalid artwork selection');
    return queue.importFiles(files);
  };
  handle('batch-files',async()=>{
    const result = await dialog.showOpenDialog(window,{properties:['openFile','multiSelections'],filters});
    return result.canceled ? null : validateFiles(result.filePaths);
  });
  handle('batch-drop',validateFiles);
  handle('batch-folder',async()=>{
    const result = await dialog.showOpenDialog(window,{properties:['openDirectory']});
    return result.canceled ? null : validateFiles(await scanFolder(result.filePaths[0],state.autopilot.recursive));
  });
  handle('batch-preferences',async preferences=>{
    state.autopilot = validatePreferences(preferences);
    await save();
    return state.autopilot;
  });
  handle('batch-start',async preferences=>{
    if (!state.destination || !destinations.has(await fs.realpath(state.destination))) throw new Error('Choose an output folder');
    state.autopilot = validatePreferences(preferences);
    await save();
    return queue.start(state.autopilot,state.destination);
  });
  handle('batch-control',(action,id)=>{
    if (!['pause','resume','cancel','retry','remove'].includes(action) || (id && !queue.get(id).input.autopilotImport))
      throw new Error('Invalid Autopilot queue action');
    return queue.control(action,id);
  });
  handle('batch-metadata',async(id,overrides)=>{
    const job = queue.get(id);
    const receipt = job.recovery;
    if (job.status !== 'review' || !job.input.autopilotImport || !receipt) throw new Error('No retained artwork is awaiting metadata');
    const current = resolveMetadata(receipt.extracted,receipt.runtime,receipt.metadataOptions);
    if (overrides === undefined) return current;
    if (!overrides || typeof overrides.title !== 'string' || typeof overrides.description !== 'string' ||
      !Array.isArray(overrides.keywords) || !overrides.keywords.every(value=>typeof value==='string') ||
      !Number.isInteger(overrides.rating)) throw new Error('Invalid metadata fields');
    const metadata = {enabled:true,overrides:{title:overrides.title,description:overrides.description,
      keywords:overrides.keywords,rating:overrides.rating}};
    const validation = resolveMetadata(receipt.extracted,receipt.runtime,{...receipt.metadataOptions,...metadata});
    if (!validation.complete) throw new Error(validation.errors.join(' · '));
    await queue.retry(id,metadata);
    return validation;
  });
  handle('batch-thumbnail',async id=>{
    const job = queue.get(id);
    if (job.status !== 'completed' || !job.input.autopilotImport) throw new Error('Artwork has no completed image');
    const image = await sharp(job.result.output,{limitInputPixels:100e6}).resize(480,320,{fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer();
    return 'data:image/jpeg;base64,' + image.toString('base64');
  });
  handle('batch-report',async()=>{
    const result = await dialog.showSaveDialog(window,{defaultPath:'UVRS-batch-report.json',filters:[{name:'JSON',extensions:['json']}]});
    if (result.canceled) return null;
    const jobs = queue.jobs.filter(j=>j.input.autopilotImport).map(j=>({
      source:j.input.source,sha256:j.hash,status:j.status,attempts:j.attempts,detected:j.result?.detected || j.detected,
      planned:j.planned,actual:j.result?.actual,output:j.result?.output,backend:j.result?.backend || j.backend,
      strategy:j.result?.strategy || j.strategy,hardware:j.result?.gpu || j.gpu,metadata:j.result?.metadata?.status,
      recovered:j.result?.recovered,outputProfile:j.result?.settings?.profile,quality:j.result?.settings?.quality,
      warnings:j.result?.validation?.warnings,diagnostic:j.error,
    }));
    await fs.writeFile(result.filePath,JSON.stringify({application:app.getVersion(),jobs},null,2));
    return result.filePath;
  });
  handle('metadata-validate',(id,config)=>{const p=projects.get(id);if(!p)throw new Error('Open a project first');return resolveMetadata(p.metadata.extracted,p.runtimeMetadata,{...state.metadata,...config});});
  handle('metadata-settings',async config=>{if(typeof config.enabled!=='boolean'||![0,5].includes(config.defaultRating)||!Number.isInteger(config.maxKeywords)||config.maxKeywords<1||config.maxKeywords>1000)throw new Error('Invalid metadata preferences');state.metadata={enabled:config.enabled,defaultRating:config.defaultRating,maxKeywords:config.maxKeywords};await save();return state.metadata;});
  handle('open',async(folder=false)=>{const result=await dialog.showOpenDialog(window,{properties:folder?['openDirectory']:['openFile'],filters:folder?[]:[{name:'Artwork',extensions:['html','htm','svg','js','mjs','ts','tsx','jsx']}]});return result.canceled?null:register(result.filePaths[0]);});
  handle('drop',source=>{if(typeof source!=='string')throw new Error('Invalid file');return register(source);});
  handle('recent',source=>{if(!state.history.includes(source))throw new Error('Unknown history item');return register(source);});
  handle('paste',async text=>{if(typeof text!=='string'||text.length>5_000_000)throw new Error('HTML exceeds editor limit');const dir=path.join(data,'pasted',crypto.randomUUID());await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'index.html');await fs.writeFile(file,text);return register(file);});
  handle('destination',async()=>{const r=await dialog.showOpenDialog(window,{properties:['openDirectory','createDirectory']});if(r.canceled)return null;state.destination=await fs.realpath(r.filePaths[0]);destinations.add(state.destination);await save();return state.destination;});
  handle('enqueue',async(id,settings,preview=false,metadataConfig={})=>{
    const p=projects.get(id);if(!p)throw new Error('Open a project first');
    const s={...defaults,...settings};validateSettings(s);
    if(!Array.isArray(s.allowedOrigins)||s.allowedOrigins.length>20)throw new Error('Invalid allowed origins');
    s.allowedOrigins=s.allowedOrigins.filter(Boolean).map(o=>{const u=new URL(o);if(u.protocol!=='https:'||u.origin!==o)throw new Error('Allowlist entries must be exact HTTPS origins');return u.origin;});
    if(s.allowedOrigins.length){const r=await dialog.showMessageBox(window,{type:'warning',buttons:['Block / cancel','Allow for this job'],defaultId:0,cancelId:0,message:'Allow this artwork to contact external HTTPS origins?',detail:s.allowedOrigins.join('\n')+'\nRemote code and requests can access the project assets rendered in this browser.'});if(r.response!==1)throw new Error('External dependencies not authorized');}
    let destination=state.destination;
    if(preview){destination=path.join(data,'previews');await fs.mkdir(destination,{recursive:true});}
    else if(!destination||!destinations.has(await fs.realpath(destination)))throw new Error('Select an export destination');
    if(!preview){state.settings=s;await save();}
    const metadata={...metadataDefaults,...state.metadata,...metadataConfig,allowWithout:false};
    if(preview){metadata.enabled=false;metadata.allowWithout=true;metadata.preview=true;}
    else if(!metadata.enabled){const r=await dialog.showMessageBox(window,{type:'warning',buttons:['Cancel','Export without metadata'],defaultId:0,cancelId:0,message:'Export without embedded metadata?',detail:'This output will be marked metadata-incomplete. Title, description, keywords and rating will not be embedded.'});if(r.response!==1)throw new Error('Metadata-free export not approved');metadata.allowWithout=true;}
    return queue.add({source:p.file,destination,settings:s,preview,metadata});
  });
  handle('cancel',id=>queue.cancel(id));handle('retry',async(id,config,projectId)=>{const j=queue.jobs.find(j=>j.id===id);if(j?.recovery){const p=projects.get(projectId);if(!p||p.file!==j.recovery.source)throw new Error('Open the failed job’s original artwork to edit and retry its metadata');if(config?.enabled===false){const answer=await dialog.showMessageBox(window,{buttons:['Cancel','Publish without metadata'],defaultId:0,cancelId:0,message:'Publish the retained render without metadata?'});if(answer.response!==1)throw new Error('Not approved');config.allowWithout=true;}}return queue.retry(id,config);});
  handle('preview',async id=>{const job=queue.jobs.find(j=>j.id===id);if(job?.status!=='completed')throw new Error('Render not completed');const image=await fs.readFile(job.result.output);const mime=job.input.settings.format==='jpeg'?'image/jpeg':job.input.settings.format==='webp'?'image/webp':'image/png';return {url:'data:'+mime+';base64,'+image.toString('base64'),result:job.result};});
  handle('reveal',async id=>{const job=queue.jobs.find(j=>j.id===id);if(job?.result?.output)shell.showItemInFolder(job.result.output);else throw new Error('No output');});
  handle('gpu-report',async id=>{const job=queue.jobs.find(j=>j.id===id);if(!job?.result?.gpu)throw new Error('Complete a render first to inspect the actual backend');const r=await dialog.showSaveDialog(window,{defaultPath:'UVRS-GPU-diagnostics.json',filters:[{name:'JSON',extensions:['json']}]});if(r.canceled)return null;const report={application:app.getVersion(),platform:process.platform,arch:process.arch,electron:process.versions.electron,actual:job.result.actual,gpu:job.result.gpu,backendClassification:job.result.gpu.software?'software':job.result.gpu.webgl&&/NVIDIA|AMD|Radeon|Intel|Apple|Qualcomm|Adreno/i.test(job.result.gpu.renderer)?'hardware-reported':'unknown/unavailable',notes:'Observed renderer identity only; this does not certify all NVIDIA features or available GPU memory.'};await fs.writeFile(r.filePath,JSON.stringify(report,null,2));return r.filePath;});
  handle('folder',async()=>{if(!state.destination)throw new Error('Select a destination');const error=await shell.openPath(state.destination);if(error)throw new Error(error);});
  handle('vector',async(id,eps,stock)=>{const p=projects.get(id);if(!p||!state.destination)throw new Error('Select SVG and destination');if(eps){const r=await dialog.showMessageBox(window,{type:'warning',buttons:['Cancel','Run Inkscape'],defaultId:0,cancelId:0,message:'Run the verified Inkscape executable for EPS conversion?',detail:adapters.inkscape.executable||'Unavailable'});if(r.response!==1)throw new Error('Adapter not authorized');}return exportVector(p.file,state.destination,{eps,stock,adapters});});
  window=new BrowserWindow({width:1460,height:950,minWidth:790,minHeight:570,backgroundColor:'#101216',title:'Universal Visual Render Studio',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',e=>e.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_web,_permission,callback)=>callback(false));
  await window.loadFile(path.join(__dirname,'../ui/index.html'));
});
app.on('window-all-closed',()=>app.quit());
let quitting = false, shutdownInProgress = false;
app.on('before-quit',event=>{
  if (quitting || !queue) return;
  event.preventDefault();
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  void queue.shutdown().catch(console.error).finally(()=>{quitting=true;app.quit();});
});
