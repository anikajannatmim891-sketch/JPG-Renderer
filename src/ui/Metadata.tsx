import React from 'react';
export type MetadataConfig={enabled:boolean;defaultRating:number;maxKeywords:number;overrides?:Record<string,unknown>};
export type MetadataReport={value:{title:string;description:string;keywords:string[];rating:number};source:string;sources:Record<string,string>;errors:string[];warnings:string[];complete:boolean};
export function MetadataPanel({report,config,onPreference,onEdit,status}:{report:MetadataReport|null;config:MetadataConfig;onPreference:(config:MetadataConfig)=>void;onEdit:(key:string,value:unknown)=>void;status:string}){
 const value=report?.value||{title:'',description:'',keywords:[],rating:config.defaultRating};
 return <details className="metadata-panel" open><summary>Metadata</summary>
 <label className="check"><input type="checkbox" checked={config.enabled} onChange={e=>onPreference({...config,enabled:e.target.checked})}/>Automatically embed source metadata in every export</label>
 <label className="check"><input type="checkbox" checked={config.defaultRating===5} onChange={e=>onPreference({...config,defaultRating:e.target.checked?5:0})}/>Default rating: 5 stars</label>
 <label>Title<input aria-label="Metadata title" value={value.title} onChange={e=>onEdit('title',e.target.value)}/></label>
 <label>Description<textarea aria-label="Metadata description" value={value.description} onChange={e=>onEdit('description',e.target.value)}/></label>
 <label>Keywords · {value.keywords.length} / {config.maxKeywords}<textarea aria-label="Metadata keywords" value={value.keywords.join(', ')} onChange={e=>onEdit('keywords',e.target.value.split(','))}/></label>
 <div className="keyword-list">{value.keywords.map((k,i)=><span className={i<10?'important':''} key={i}>{i+1}. {k.trim()||'(empty)'}</span>)}</div>
 <p className="hint">Order is preserved. First 10 keywords are highlighted. Multiword phrases stay together. Duplicate and empty entries are reported.</p>
 <div className="twocol"><label>Rating<select aria-label="Metadata rating" value={value.rating} onChange={e=>onEdit('rating',Number(e.target.value))}>{[0,1,2,3,4,5].map(n=><option key={n} value={n}>{n} {'★'.repeat(n)}</option>)}</select></label><label>Keyword limit<input aria-label="Metadata keyword limit" type="number" min={1} max={1000} value={config.maxKeywords} onChange={e=>onPreference({...config,maxKeywords:Number(e.target.value)})}/></label></div>
 <p className="hint">Rating is standard XMP image metadata, not a Stock moderation or customer score.</p>
 <div className="metadata-status"><p><b>Source:</b> {report?.source||'No artwork loaded'}</p><p><b>Validation:</b> {report?.complete?'Complete':report?'Needs attention':'Not checked'}</p><p><b>Embedding:</b> {status}</p></div>
 {report?.errors.map((e,i)=><p className="warning" key={'e'+i}>{e}</p>)}{report?.warnings.map((e,i)=><p className="warning" key={'w'+i}>{e}</p>)}
 </details>;
}
