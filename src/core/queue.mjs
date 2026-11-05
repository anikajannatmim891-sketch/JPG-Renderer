import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {renderArtwork} from './render.mjs';
export class RenderQueue {
  constructor(dir,onChange=()=>{},renderer=renderArtwork){this.dir=dir;this.onChange=onChange;this.renderer=renderer;this.jobs=[];this.active=null;this.saving=Promise.resolve();}
  async init(){await fs.mkdir(this.dir,{recursive:true});try{const data=JSON.parse(await fs.readFile(path.join(this.dir,'queue.json'),'utf8'));if(!Array.isArray(data))throw new Error('Invalid queue state');this.jobs=data.slice(-100);for(const j of this.jobs)if(['queued','running'].includes(j.status)){j.status='failed';j.error='Interrupted by previous shutdown; retry explicitly';}}catch(e){if(e.code!=='ENOENT')throw e;}await this.persist();return this;}
  snapshot(){return structuredClone(this.jobs);}
  async persist(){const data=JSON.stringify(this.jobs.slice(-100),null,2);this.saving=this.saving.catch(()=>{}).then(async()=>{const file=path.join(this.dir,'queue.json'),temp=file+'.tmp';await fs.writeFile(temp,data);await fs.rename(temp,file);});await this.saving;this.onChange(this.snapshot());}
  async add(input){while(this.jobs.length>=100){const index=this.jobs.findIndex(j=>['completed','failed','cancelled'].includes(j.status));if(index<0)throw new Error('Queue is full (100 active/waiting jobs). Wait for completion before adding more.');this.jobs.splice(index,1);}const job={id:crypto.randomUUID(),status:'queued',created:new Date().toISOString(),input,progress:[],result:null};this.jobs.push(job);await this.persist();void this.pump();return job.id;}
  async cancel(id){const job=this.jobs.find(j=>j.id===id);if(!job)throw new Error('Unknown job');if(job.status==='running')this.active?.controller.abort();else if(job.status==='queued'){job.status='cancelled';await this.persist();}}
  async retry(id,metadata){const j=this.jobs.find(j=>j.id===id);if(!j||!['failed','cancelled'].includes(j.status))throw new Error('Only failed/cancelled jobs can be retried');return this.add(j.recovery?{...j.input,recovery:j.recovery,metadata:metadata||j.recovery.metadataOptions}:j.input);}
  async pump(){if(this.active)return;const job=this.jobs.find(j=>j.status==='queued');if(!job)return;const controller=new AbortController();this.active={id:job.id,controller};job.status='running';try{await this.persist();job.result=await this.renderer({...job.input,history:this.jobs.filter(j=>j.status==='completed').map(j=>j.result?.validation).filter(Boolean),signal:controller.signal,onProgress:event=>{job.progress.push({...event,at:new Date().toISOString()});job.progress=job.progress.slice(-100);this.onChange(this.snapshot());}});job.status='completed';}catch(e){job.status=controller.signal.aborted?'cancelled':'failed';job.error=e.message;if(e.recovery)job.recovery=e.recovery;}finally{this.active=null;await this.persist();void this.pump();}}
  async shutdown(){this.active?.controller.abort();await this.persist();}
}
