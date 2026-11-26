import React, {useEffect,useState} from 'react';
import './autopilot.css';

type Dimensions = {width:number;height:number;source?:string;notes?:string[]};
type Preferences = {profile:string;preset:string;customEdge:number;qualityFloor:number;allowLower:boolean;recursive:boolean};
type Job = {
  id:string;status:string;input:{source:string;autopilotImport?:boolean};detected?:Dimensions;planned?:Dimensions;
  backend?:string;strategy?:string;started?:number;finished?:number;error?:string;
  progress:{phase:string;message:string;percent?:number}[];
  result?:{actual:Dimensions;durationMs:number;output:string;recovered?:boolean;strategy?:string;backend?:string};
};
const names:Record<string,string> = {
  imported:'Imported',queued:'Waiting',paused:'Paused',completed:'Completed',failed:'Failed',review:'Metadata review',cancelled:'Cancelled',
  analyzing:'Analyzing',planned:'Analyzing',backend:'Analyzing',rendering:'Rendering',tile:'Rendering',fallback:'Recovering',
  encoding:'Encoding',metadata:'Embedding metadata',verifying:'Verifying',running:'Analyzing',
};
const dimensions = (pair?:Dimensions) => pair ? pair.width.toLocaleString() + ' × ' + pair.height.toLocaleString() : '—';
const needsAttention = (job:Job) => ['failed','review'].includes(job.status);
const last = (job:Job) => job.progress.at(-1);
const phase = (job:Job) => job.status === 'running' ? last(job)?.phase || 'running' : job.status;
const initial:Preferences = {profile:'adobe',preset:'10K',customEdge:10240,qualityFloor:88,allowLower:false,recursive:false};

export function Autopilot() {
  const [jobs,setJobs] = useState<Job[]>([]);
  const [prefs,setPrefs] = useState(initial);
  const [destination,setDestination] = useState('');
  const [paused,setPaused] = useState(false);
  const [notice,setNotice] = useState('');
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [dragging,setDragging] = useState(false);
  const [tab,setTab] = useState<'queue'|'attention'>('queue');
  const [page,setPage] = useState(0);
  const [activePreview,setActivePreview] = useState<{id:string;url:string}|null>(null);
  const [metadataDraft,setMetadataDraft] = useState<{id:string;title:string;description:string;keywords:string;rating:number}|null>(null);
  const [selected,setSelected] = useState<string|null>(null);

  useEffect(()=>{
    let mounted = true;
    const unsubscribe = window.studio.onJobs((items,stopped)=>{
      setJobs(items.filter(item=>('autopilotImport' in item.input)));
      setPaused(stopped);
    });
    window.studio.call('state').then(data=>{
      if (!mounted) return;
      setJobs(data.jobs.filter((job:Job)=>job.input.autopilotImport));
      setPrefs({...initial,...data.autopilot});
      setDestination(data.destination || '');
      setPaused(data.paused);
    }).catch(error=>mounted && setError(error.message));
    return ()=>{mounted=false;unsubscribe();};
  },[]);

  async function call(channel:string,...args:unknown[]) {
    setError('');
    try {return await window.studio.call(channel,...args);}
    catch(error) {setError((error as Error).message);return null;}
  }

  const change = (value:Partial<Preferences>) => {
    const updated = {...prefs,...value};
    setPrefs(updated);
    if (updated.customEdge >= 1 && updated.qualityFloor >= 1 && updated.qualityFloor <= 96)
      void call('batch-preferences',updated);
  };

  async function importFiles(channel:string,...args:unknown[]) {
    setBusy(true);
    const result = await call(channel,...args);
    setBusy(false);
    if (result) {
      setNotice(`${result.added} added${result.duplicates ? ' · ' + result.duplicates + ' duplicate(s) skipped' : ''}`);
      if (result.errors.length) setError(result.errors.map((item:{source:string;error:string})=>item.source + ' · ' + item.error).join('\n'));
    }
  }

  const running = jobs.filter(j=>j.status==='running');
  const completed = jobs.filter(j=>j.status==='completed');
  const waiting = jobs.filter(j=>j.status==='queued');
  const imported = jobs.filter(j=>j.status==='imported');
  const attention = jobs.filter(needsAttention);
  const average = completed.length ? completed.slice(-12).reduce((sum,j)=>sum+(j.result?.durationMs || 0),0)/Math.min(completed.length,12) : 0;
  const eta = Math.ceil((waiting.length+running.length)*average/60000);
  const counters:[string,number][] = [
    ['Imported',jobs.length],['Analyzing',running.filter(j=>['analyzing','planned','backend','running'].includes(phase(j))).length],
    ['Waiting',waiting.length + imported.length + jobs.filter(j=>j.status==='paused').length],
    ['Rendering',running.filter(j=>['rendering','tile','fallback','encoding'].includes(phase(j))).length],
    ['Embedding metadata',running.filter(j=>phase(j)==='metadata').length],
    ['Verifying',running.filter(j=>phase(j)==='verifying').length],
    ['Completed',completed.length],['Recovered',completed.filter(j=>j.result?.recovered).length],['Needs attention',attention.length],
  ];
  const visible = tab==='attention' ? attention : jobs;
  const size = 35;
  const pages = Math.max(1,Math.ceil(visible.length/size));
  const currentPage = Math.min(page,pages-1);
  const detail = visible.find(j=>j.id===selected);
  const control = (action:string,id?:string) => void call('batch-control',action,id);

  return <main className="autopilot" onDragOver={event=>{event.preventDefault();setDragging(true);}}
    onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDragging(false);}}
    onDrop={event=>{
      event.preventDefault();setDragging(false);
      void importFiles('batch-drop',Array.from(event.dataTransfer.files,window.studio.filePath));
    }}>
    <section className="production-header">
      <div><h1>Autopilot</h1><p>Batch artwork rendering and stock JPEG export</p></div>
      <button className="production-start" disabled={!destination || !imported.length || busy}
        onClick={async()=>{const count=await call('batch-start',prefs);if(count)setNotice(count+' job(s) queued');}}>
        <span aria-hidden="true">▶</span> Start Autopilot
      </button>
    </section>
    <div className="production-setup">
      <section className={'import-area'+(dragging?' dragging':'')} aria-label="Import artwork">
        <div className="import-symbol" aria-hidden="true">↧</div>
        <div><h2>Drop HTML files</h2><p>HTML, SVG, JavaScript, and TypeScript</p></div>
        <div className="production-actions">
          <button disabled={busy} onClick={()=>void importFiles('batch-files')}>Add Files</button>
          <button disabled={busy} onClick={()=>void importFiles('batch-folder')}>Add Folder</button>
        </div>
        <label className="production-check"><input type="checkbox" checked={prefs.recursive} onChange={e=>change({recursive:e.target.checked})}/> Include subfolders</label>
      </section>
      <section className="production-options" aria-label="Export settings">
        <div className="folder-field">
          <label htmlFor="production-destination">Output Folder</label>
          <button id="production-destination" title={destination}
            onClick={async()=>{const path=await call('destination');if(path)setDestination(path);}}>
            {destination || 'Choose output folder…'}
          </button>
          <button disabled={!destination} onClick={()=>void call('folder')}>Open Output Folder</button>
        </div>
        <label>Global Resolution Preset<select value={prefs.preset} onChange={e=>change({preset:e.target.value})}>
          {['4K','6K','8K','10K','12K'].map(p=><option key={p}>{p}</option>)}
          <option value="custom">Custom longest edge</option><option value="max">Maximum within stock limits</option>
        </select></label>
        <label>Output Profile<select value={prefs.profile} onChange={e=>change({profile:e.target.value})}>
          <option value="adobe">Adobe Stock</option><option value="shutterstock">Shutterstock</option>
        </select></label>
        {prefs.preset==='custom'&&<label>Longest edge in pixels<input type="number" min="1" max="65535" value={prefs.customEdge} onChange={e=>change({customEdge:Number(e.target.value)})}/></label>}
        <details className="production-settings">
          <summary>Output options</summary>
          <label>JPEG quality floor<input type="number" min="1" max="96" value={prefs.qualityFloor} onChange={e=>change({qualityFloor:Number(e.target.value)})}/></label>
          <label className="production-check"><input type="checkbox" checked={prefs.allowLower} onChange={e=>change({allowLower:e.target.checked})}/> Allow a lower native resolution when WebGL limits require it</label>
        </details>
      </section>
    </div>
    <section className="production-counts" aria-label="Production counts">
      {counters.map(([label,value])=><div key={label} className={label==='Needs attention'&&value?'attention-count':''}><strong>{value.toLocaleString()}</strong><span>{label}</span></div>)}
    </section>
    <section className="production-queue" aria-label="Render queue">
      <div className="production-queue-header">
        <div className="queue-tabs">
          <button className={tab==='queue'?'current':''} onClick={()=>{setTab('queue');setPage(0);}}>Queue</button>
          <button className={tab==='attention'?'current':''} onClick={()=>{setTab('attention');setPage(0);}}>Needs Attention{attention.length ? ' ('+attention.length+')' : ''}</button>
        </div>
        <span className="queue-state">{paused ? 'Paused or waiting for active work to finish' : running.length ? (eta ? 'About '+eta+' min remaining' : 'Estimating time…') : ''}</span>
        <div className="production-actions">
          <button disabled={!waiting.length||paused} onClick={()=>control('pause')}>Pause All</button>
          <button disabled={!paused&&!jobs.some(j=>j.status==='paused')} onClick={()=>control('resume')}>Resume All</button>
          <button disabled={!running.length&&!waiting.length&&!imported.length&&!jobs.some(j=>j.status==='paused')} onClick={()=>control('cancel')}>Cancel All</button>
          <button disabled={!jobs.some(j=>j.status==='failed')} onClick={()=>control('retry')}>Retry Failed</button>
        </div>
      </div>
      {error&&<div className="production-feedback failure" role="alert">{error}</div>}
      {!error&&notice&&<div className="production-feedback" role="status">{notice}</div>}
      <div className="production-table-scroll">
        <table><thead><tr><th>Artwork</th><th>Design size</th><th>Export size</th><th>Renderer</th><th>Status</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
        <tbody>{visible.slice(currentPage*size,currentPage*size+size).map(job=>{
          const status = phase(job);
          const short = job.input.source.split(/[\\/]/).at(-1);
          const progress = last(job);
          return <tr key={job.id} className={selected===job.id?'selected-row':''}>
            <td><button className="job-name" title={job.input.source} onClick={()=>{setActivePreview(null);setSelected(selected===job.id?null:job.id);}}>{short}</button></td>
            <td>{dimensions(job.detected)}</td><td>{dimensions(job.result?.actual || job.planned)}</td>
            <td>{job.result?.backend || job.backend || '—'}</td>
            <td><span className={'production-status '+status}>{names[status] || status}</span>
              {job.status==='running' && progress?.phase==='tile' && <progress aria-label="Tiles captured" value={progress.percent || 0} max={1}/>}
            </td>
            <td><div className="production-actions row-actions">
              {['queued','running'].includes(job.status)&&<button onClick={()=>control('pause',job.id)}>Pause</button>}
              {job.status==='paused'&&<button onClick={()=>control('resume',job.id)}>Resume</button>}
              {['queued','paused','running','imported'].includes(job.status)&&<button onClick={()=>control('cancel',job.id)}>Cancel</button>}
              {(job.status==='failed'||job.status==='cancelled')&&<button onClick={()=>control('retry',job.id)}>Retry</button>}
              {job.status==='review'&&<button onClick={async()=>{
                const current=await call('batch-metadata',job.id);
                if (current) {
                  setSelected(job.id);
                  setMetadataDraft({id:job.id,...current.value,keywords:current.value.keywords.join('\n')});
                }
              }}>Review metadata</button>}
              {job.status==='completed'&&<><button onClick={async()=>{
                const url=await call('batch-thumbnail',job.id);if(url){setSelected(job.id);setActivePreview({id:job.id,url});}
              }}>Thumbnail</button><button onClick={()=>void call('reveal',job.id)}>Show file</button></>}
            </div></td>
          </tr>;
        })}</tbody></table>
        {!visible.length&&<div className="production-empty">{tab==='attention'?'No artwork needs attention.':'Add files or a folder to start a batch.'}</div>}
      </div>
      {detail&&<section className="production-detail" aria-label="Artwork details">
        {activePreview?.id===detail.id&&<img src={activePreview.url} alt="Thumbnail of completed JPEG"/>}
        <div><strong>{detail.input.source.split(/[\\/]/).at(-1)}</strong>
          <p>{detail.error || (detail.status==='completed' ? 'Metadata and output verified' : last(detail)?.message) || 'Ready for Autopilot'}</p>
          {detail.detected&&<p>Design size from {detail.detected.source}. {detail.detected.notes?.join(' ')}</p>}
          {detail.strategy&&<p>Capture strategy · {detail.strategy}</p>}
          {detail.result&&<p>{detail.result.output}</p>}
          {detail.status==='review' && metadataDraft && metadataDraft.id===detail.id&&
            <form className="production-review" onSubmit={async event=>{
              event.preventDefault();
              const result=await call('batch-metadata',detail.id,{...metadataDraft,keywords:metadataDraft.keywords.split('\n')});
              if (result) {setMetadataDraft(null);setNotice('Metadata-only retry queued');}
            }}>
              <label>Title<input required value={metadataDraft.title}
                onChange={e=>setMetadataDraft({...metadataDraft,title:e.target.value})}/></label>
              <label>Description<textarea required value={metadataDraft.description}
                onChange={e=>setMetadataDraft({...metadataDraft,description:e.target.value})}/></label>
              <label>Keywords, one per line<textarea required value={metadataDraft.keywords}
                onChange={e=>setMetadataDraft({...metadataDraft,keywords:e.target.value})}/></label>
              <label>Rating<input required type="number" min="0" max="5" value={metadataDraft.rating}
                onChange={e=>setMetadataDraft({...metadataDraft,rating:Number(e.target.value)})}/></label>
              <button type="submit">Save and retry metadata</button>
            </form>}
          {detail.status==='completed'&&<button onClick={()=>{control('remove',detail.id);setSelected(null);}}>Remove entry</button>}
        </div><button onClick={()=>setSelected(null)} aria-label="Close artwork details">×</button>
      </section>}
      <div className="production-footer">
        <div className="production-actions"><button disabled={!currentPage} onClick={()=>setPage(currentPage-1)}>Previous</button>
          <span>Page {currentPage+1} of {pages}</span><button disabled={currentPage+1>=pages} onClick={()=>setPage(currentPage+1)}>Next</button></div>
        <div className="production-actions"><button disabled={!completed.length} onClick={()=>control('remove')}>Clear Completed</button>
          <button disabled={!jobs.length} onClick={async()=>{const file=await call('batch-report');if(file)setNotice('Batch report saved to '+file);}}>Save Batch Report</button></div>
      </div>
    </section>
  </main>;
}
