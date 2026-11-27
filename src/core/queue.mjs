import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {renderArtwork} from './render.mjs';
import {presets,profiles} from './dimensions.mjs';

const extensions = new Set(['.html','.htm','.svg','.js','.mjs','.jsx','.ts','.tsx']);
const terminal = new Set(['completed','failed','cancelled','review']);
export const autopilotDefaults = {profile:'adobe',preset:'10K',customEdge:10240,qualityFloor:88,allowLower:false,recursive:false,hardwareOnly:false,sampleLimit:512,renderBudgetMs:240000};

export function validatePreferences(preferences) {
  const {profile,preset,customEdge,qualityFloor,allowLower,recursive,hardwareOnly,sampleLimit,renderBudgetMs} = {...autopilotDefaults,...preferences};
  if (!Object.hasOwn(profiles,profile) || !(Object.hasOwn(presets,preset) || ['max','custom'].includes(preset)) ||
      !Number.isSafeInteger(customEdge) || customEdge < 1 || customEdge > 65535 ||
      !Number.isInteger(qualityFloor) || qualityFloor < 1 || qualityFloor > 96 ||
      typeof allowLower !== 'boolean' || typeof recursive !== 'boolean' || typeof hardwareOnly !== 'boolean' ||
      !Number.isSafeInteger(sampleLimit) || sampleLimit<1 || sampleLimit>4096 ||
      !Number.isSafeInteger(renderBudgetMs) || renderBudgetMs<30000 || renderBudgetMs>3600000 ||
      (preset==='16K' && profiles[profile].stock)) throw new Error('Invalid Autopilot preferences');
  return {profile,preset,customEdge,qualityFloor,allowLower,recursive,hardwareOnly,sampleLimit,renderBudgetMs};
}

const artworkFile = file => extensions.has(path.extname(file).toLowerCase());
export async function scanFolder(folder, recursive) {
  const files = [];
  const pending = [folder];
  while (pending.length) {
    const dir = pending.pop();
    const entries = await fs.opendir(dir);
    for await (const entry of entries) {
      const selected = path.join(dir,entry.name);
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.isDirectory() && recursive) pending.push(selected);
      if (entry.isFile() && artworkFile(selected)) files.push(selected);
    }
  }
  return files.sort();
}

export async function sourceDigest(file, signal) {
  const hash = crypto.createHash('sha256');
  await pipeline(createReadStream(file),hash,signal ? {signal} : {});
  return hash.digest('hex');
}

export class RenderQueue {
  constructor(dir,onChange=()=>{},renderer=renderArtwork) {
    this.dir = dir;
    this.workspace = path.join(dir,'recovery');
    this.onChange = onChange;
    this.renderer = renderer;
    this.jobs = [];
    this.byId = new Map();
    this.hashes = new Set();
    this.workers = new Map();
    this.paused = false;
    this.closed = false;
    this.progressAt = 0;
  }

  get active() {return this.workers.values().next().value || null;}

  async init() {
    await fs.mkdir(this.workspace,{recursive:true});
    this.db = new DatabaseSync(path.join(this.dir,'production.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, job TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences (name TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.upsert = this.db.prepare('INSERT INTO jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET job=excluded.job');
    this.delete = this.db.prepare('DELETE FROM jobs WHERE id=?');
    const started = this.db.prepare("SELECT value FROM preferences WHERE name='initialized'").get();
    if (!started) {
      let legacy = [];
      try { legacy = JSON.parse(await fs.readFile(path.join(this.dir,'queue.json'),'utf8')); }
      catch(error) {if (error.code !== 'ENOENT') throw error;}
      if (!Array.isArray(legacy)) throw new Error('Invalid legacy queue state');
      this.transaction(()=>{
        for (const job of legacy) this.save(job);
        this.db.prepare("INSERT INTO preferences VALUES ('initialized','1')").run();
      });
    }
    this.paused = this.db.prepare("SELECT value FROM preferences WHERE name='paused'").get()?.value === '1';
    for (const row of this.db.prepare('SELECT job FROM jobs ORDER BY rowid').iterate()) {
      const job = JSON.parse(row.job);
      this.index(job);
      if (job.status === 'running') {
        job.status = 'queued';
        job.interrupted = true;
        this.save(job);
      }
    }
    const retained = new Set(this.jobs.map(j=>j.recovery?.encoded).filter(Boolean));
    for (const name of await fs.readdir(this.workspace)) {
      const file = path.join(this.workspace,name);
      if (!retained.has(file)) await fs.rm(file,{force:true}).catch(()=>{});
    }
    setImmediate(()=>void this.pump());
    return this;
  }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {operation();this.db.exec('COMMIT');}
    catch(error) {this.db.exec('ROLLBACK');throw error;}
  }

  index(job) {
    this.jobs.push(job);
    this.byId.set(job.id,job);
    if (job.hash) this.hashes.add(job.hash);
  }

  save(job) {
    this.upsert.run(job.id,JSON.stringify(job));
  }

  snapshot() {
    return structuredClone(this.jobs);
  }

  notify() {
    this.onChange(this.snapshot(),this.paused);
  }

  async persist() {
    this.transaction(()=>{for (const job of this.jobs) this.save(job);});
    this.notify();
  }

  makeJob(input,status,hash) {
    return {id:crypto.randomUUID(),status,hash,created:new Date().toISOString(),input,progress:[],result:null,attempts:0};
  }

  async add(input) {
    const job = this.makeJob(input,'queued');
    this.save(job);
    this.index(job);
    this.notify();
    setImmediate(()=>void this.pump());
    return job.id;
  }

  async importFiles(files) {
    const added = [];
    const errors = [];
    let duplicates = 0;
    const seen = new Set();
    for (const source of files) {
      try {
        if (typeof source !== 'string' || !path.isAbsolute(source) || !artworkFile(source))
          throw new Error('Unsupported artwork file');
        const file = await fs.realpath(source);
        if (!(await fs.stat(file)).isFile()) throw new Error('Select an artwork file');
        const hash = await sourceDigest(file);
        if (this.hashes.has(hash) || seen.has(hash)) {duplicates++;continue;}
        seen.add(hash);
        added.push(this.makeJob({source:file,autopilotImport:true},'imported',hash));
      } catch(error) {
        errors.push({source,error:error.message});
      }
    }
    // Recheck after all asynchronous file reads in case another import overlapped.
    const unique = added.filter(job=>!this.hashes.has(job.hash));
    this.transaction(()=>{for (const job of unique) this.save(job);});
    for (const job of unique) this.index(job);
    this.notify();
    return {added:unique.length,duplicates:duplicates+added.length-unique.length,errors};
  }

  start(config,destination) {
    const autopilot = validatePreferences(config);
    const started = this.jobs.filter(job=>job.status === 'imported');
    this.transaction(()=>{
      for (const job of started) {
        job.input = {...job.input,autopilot,destination,settings:{quality:96,qualityFloor:autopilot.qualityFloor},
          metadata:{enabled:true,maxKeywords:profiles[autopilot.profile].keywords},writeManifest:false};
        job.status = 'queued';
        this.save(job);
      }
      this.setPaused(false);
    });
    this.notify();
    void this.pump();
    return started.length;
  }

  setPaused(paused) {
    this.db.prepare("INSERT INTO preferences VALUES ('paused',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(paused?'1':'0');
    this.paused = paused;
  }

  get(id) {
    const job = this.byId.get(id);
    if (!job) throw new Error('Unknown job');
    return job;
  }

  async control(action,id) {
    const jobs = id ? [this.get(id)] : this.jobs.filter(j=>j.input.autopilotImport);
    const cleanup = [];
    this.transaction(()=>{
      if (!id && ['pause','resume','cancel'].includes(action)) this.setPaused(action==='pause');
      for (const job of jobs) {
        if (action === 'pause') {
          if (!id) continue; // Let the current artwork finish, then stop dispatch.
          if (job.status === 'queued') job.status = 'paused';
          else if (job.status === 'running') this.stopActive(job,'paused');
        } else if (action === 'resume') {
          if (job.status === 'paused') job.status = 'queued';
        } else if (action === 'cancel') {
          if (job.status === 'running') this.stopActive(job,'cancelled');
          else if (!terminal.has(job.status)) {
            job.status = 'cancelled';
            if (job.recovery) cleanup.push(job.recovery.encoded);
            delete job.recovery;
          }
        } else if (action === 'retry') {
          if ((!id && job.status !== 'failed') || !['failed','cancelled','review'].includes(job.status)) continue;
          job.status = job.input.destination ? 'queued' : 'imported';
          job.attempts = 0;
          delete job.error;
        } else if (action === 'remove') {
          if (id && job.status==='running') throw new Error('Pause or cancel the active artwork before removing its entry');
          if (!id && job.status!=='completed') continue;
          if (job.recovery) cleanup.push(job.recovery.encoded);
          this.delete.run(job.id);
          this.byId.delete(job.id);
          if (job.hash) this.hashes.delete(job.hash);
          continue;
        } else throw new Error('Unknown queue action');
        this.save(job);
      }
    });
    if (action === 'remove') this.jobs = this.jobs.filter(job=>this.byId.has(job.id));
    await Promise.all(cleanup.map(file=>fs.rm(file,{force:true})));
    this.notify();
    void this.pump();
  }

  stopActive(job,status) {
    const worker = this.workers.get(job.id);
    if (!worker) return;
    worker.stop = status;
    worker.controller.abort();
  }

  cancel(id) {return this.control('cancel',id);}

  async retry(id,metadata) {
    const job = this.get(id);
    if (!['failed','cancelled','review'].includes(job.status)) throw new Error('Only failed or cancelled artwork can be retried');
    if (metadata && job.recovery) job.recovery.metadataOptions = {...job.recovery.metadataOptions,...metadata};
    await this.control('retry',id);
    return id;
  }

  async pump() {
    if (this.closed || this.workers.size >= 2) return;
    const workers = [...this.workers.values()];
    const job = this.jobs.find(item=>item.status === 'queued' && !this.workers.has(item.id) &&
      (!this.paused || !item.input.autopilotImport));
    if (!job) return;
    if (workers.length && (!job.input.autopilotImport || !workers.every(worker=>worker.overlap))) return;
    const controller = new AbortController();
    const active = {id:job.id,controller,stop:null,done:null,overlap:false};
    this.workers.set(job.id,active);
    active.done = this.run(job,active);
    try {await active.done;}
    catch(error) {console.error('Queue persistence error',error);}
    finally {
      this.workers.delete(job.id);
      if (!this.closed) setImmediate(()=>void this.pump());
    }
  }

  allowOverlap(job,worker,receipt) {
    const imagePixels = receipt.actual.width * receipt.actual.height;
    const constrained = process.constrainedMemory?.();
    const available = Math.min(os.freemem(),constrained ? constrained-process.memoryUsage.rss() : Infinity);
    if (!job.input.autopilotImport || imagePixels > 12e6 || available < 2.5e9) return;
    // A small ExifTool/QA stage can overlap the next capture only after its
    // Chromium instance has closed and there is sufficient system memory.
    worker.overlap = true;
    setImmediate(()=>void this.pump());
  }

  async run(job,active) {
    job.status = 'running';
    job.attempts++;
    job.started = Date.now();
    job.progress = [];
    this.save(job);
    this.notify();
    let cleanup;
    try {
      if (!job.recovery && job.hash && await sourceDigest(job.input.source,active.controller.signal) !== job.hash)
        throw new Error('Source changed after import; add the current version as a new artwork');
      this.onProgress(job,{phase:'analyzing',message:'Inspecting source'});
      if (job.recovery) this.allowOverlap(job,active,job.recovery);
      job.result = await this.renderer({...job.input,jobId:job.id,workspace:this.workspace,
        recovery:job.recovery,metadata:job.recovery?.metadataOptions || job.input.metadata,
        history:this.jobs.filter(item=>item.status==='completed').slice(-200).map(item=>item.result?.validation).filter(Boolean),
        signal:active.controller.signal,onProgress:event=>this.onProgress(job,event),
        onCheckpoint:receipt=>{
          job.recovery = receipt;
          this.save(job);
          this.allowOverlap(job,active,receipt);
        }});
      job.status = 'completed';
      job.finished = Date.now();
      job.result.recovered ||= job.interrupted;
      cleanup = job.recovery?.encoded;
      delete job.recovery;
      delete job.error;
    } catch (error) {
      if (error.recovery) job.recovery = error.recovery;
      job.error = error.message;
      if (active.stop) {
        job.status = active.stop;
        if (active.stop === 'cancelled') {cleanup=job.recovery?.encoded;delete job.recovery;}
      } else if (error.needsReview) job.status = 'review';
      else if (job.input.autopilotImport && ((job.recovery && job.attempts<3) || (error.retryable && job.attempts<2))) job.status = 'queued';
      else job.status = 'failed';
    }
    this.save(job);
    this.notify();
    if (cleanup) await fs.rm(cleanup,{force:true});
  }

  onProgress(job,event) {
    const {data,...progress} = event;
    if (data) Object.assign(job,data);
    const previous = job.progress.at(-1);
    job.progress.push({...progress,at:new Date().toISOString()});
    if (job.progress.length>100) job.progress.shift();
    const now = Date.now();
    if (previous?.phase !== event.phase || now-this.progressAt > 350) {
      this.progressAt = now;
      this.notify();
    }
  }

  async shutdown() {
    this.closed = true;
    const workers = [...this.workers.values()];
    for (const worker of workers) {
      worker.stop = 'queued';
      worker.controller.abort();
    }
    await Promise.allSettled(workers.map(worker=>worker.done));
    this.db.close();
  }
}
