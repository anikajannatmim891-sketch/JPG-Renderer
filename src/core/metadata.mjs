import {parse} from 'parse5';
import fs from 'node:fs/promises';
export const metadataDefaults={enabled:true,defaultRating:5,maxKeywords:49,overrides:{},allowWithout:false};
const keys=['title','description','keywords','rating'];
const own=(o,k)=>o&&Object.hasOwn(o,k);
function fields(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Metadata must be a JSON object');
  return Object.fromEntries(keys.filter(k=>own(value,k)).map(k=>[k,value[k]]));
}
export function extractHtmlMetadata(html){
  const document=parse(html),standard={},structured={},warnings=[],errors=[];let title='',jsonCount=0;
  const content=node=>(node.childNodes||[]).map(n=>n.value||content(n)).join('');
  const visit=node=>{
    const attrs=Object.fromEntries((node.attrs||[]).map(a=>[a.name.toLowerCase(),a.value]));
    if(node.tagName==='title'&&!title)title=content(node).trim();
    if(node.tagName==='meta'){
      const name=(attrs.name||attrs.property||'').toLowerCase();const value=attrs.content;
      if(value!==undefined){
        if(['dc.title','dcterms.title','title','og:title'].includes(name)&&!own(standard,'title'))standard.title=value;
        if(['description','dc.description','dcterms.description'].includes(name)&&!own(standard,'description'))standard.description=value;
        if(['keywords','dc.subject','dcterms.subject'].includes(name)){const list=value.split(',');standard.keywords=[...(standard.keywords||[]),...list];}
        if(['rating','xmp.rating','xmp:rating'].includes(name)&&!own(standard,'rating'))standard.rating=Number(value);
      }
    }
    if(node.tagName==='script'&&attrs.id==='uvrs-metadata'){
      jsonCount++;
      if(attrs.type?.toLowerCase()!=='application/json')errors.push('uvrs-metadata must use type="application/json"');
      else try{Object.assign(structured,fields(JSON.parse(content(node))));}catch(e){errors.push('Invalid uvrs-metadata JSON: '+e.message);}
    }
    for(const child of node.childNodes||[])visit(child);
  };visit(document);
  if(jsonCount>1)errors.push('Multiple uvrs-metadata blocks are ambiguous; keep one');
  return {standard,structured,title,warnings,errors};
}
export async function readSourceMetadata(project){
  if(!['html','htm'].includes(project.kind))return {standard:{},structured:{},title:'',warnings:[],errors:[]};
  const stat=await fs.stat(project.file);if(stat.size>10_000_000)throw new Error('HTML exceeds the 10 MB metadata parsing limit');
  return extractHtmlMetadata(await fs.readFile(project.file,'utf8'));
}
export function resolveMetadata(extracted,runtime,options={}){
  const config={...metadataDefaults,...options};let runtimeFields={},runtimeError;
  if(runtime!==undefined&&runtime!==null)try{runtimeFields=fields(runtime);}catch(e){runtimeError='Runtime metadata: '+e.message;}
  const value={},sources={};
  for(const key of keys){
    const layers=[[config.overrides,'user edit'],[extracted.structured,'uvrs-metadata JSON'],[runtimeFields,'runtime object'],[extracted.standard,'HTML meta tags']];
    const match=layers.find(([obj])=>own(obj,key));
    if(match){value[key]=match[0][key];sources[key]=match[1];}
    else if(key==='title'&&extracted.title){value.title=extracted.title;sources.title='document title';}
    else{value[key]=key==='rating'?config.defaultRating:key==='keywords'?[]:'';sources[key]=key==='rating'?'default rating':'missing';}
  }
  const manualComplete=['title','description','keywords'].every(k=>own(config.overrides,k));
  const warnings=[...(extracted.warnings||[]),...(manualComplete?(extracted.errors||[]).map(e=>'Source error overridden by manual metadata: '+e):[])],errors=manualComplete?[]:[...(extracted.errors||[])];if(runtimeError)errors.push(runtimeError);
  for(const k of ['title','description']){if(typeof value[k]!=='string'){errors.push(`${k} must be text`);value[k]='';}else value[k]=value[k].trim();}
  if(typeof value.keywords==='string')value.keywords=value.keywords.split(',');
  if(!Array.isArray(value.keywords)||value.keywords.some(k=>typeof k!=='string')){errors.push('Keywords must be an array of strings or comma-separated text');value.keywords=[];}else value.keywords=value.keywords.map(k=>k.trim());
  if(!value.title)errors.push('Title is missing');
  if(!value.description)errors.push('Description is missing');
  if(!value.keywords.length)errors.push('Keywords are missing');
  if(value.keywords.some(k=>!k))errors.push('Empty keyword entries must be removed explicitly');
  const seen=new Set(),duplicates=[];for(const k of value.keywords){const folded=k.toLocaleLowerCase('en-US');if(seen.has(folded))duplicates.push(k);seen.add(folded);}
  if(duplicates.length)warnings.push('Duplicate keywords: '+duplicates.join(', '));
  if(value.keywords.length>config.maxKeywords)errors.push(`Keyword count ${value.keywords.length} exceeds configured maximum ${config.maxKeywords}`);
  if([...value.title].length>70)warnings.push('Title exceeds the recommended 70 characters; it has not been shortened');
  const words=(value.title+' '+value.description).toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
  if(words.some(w=>w.length>3&&words.filter(x=>x===w).length>8))warnings.push('Possible excessive word repetition; review metadata');
  if(!Number.isInteger(value.rating)||value.rating<0||value.rating>5)errors.push('Rating must be an integer from 0 to 5');
  if(!Number.isInteger(config.maxKeywords)||config.maxKeywords<1||config.maxKeywords>1000)errors.push('Keyword limit must be from 1 to 1000');
  if(Buffer.byteLength(JSON.stringify(value),'utf8')>60_000)errors.push('Metadata exceeds the 60 KB safety limit');
  return {value,sources,source:[...new Set(Object.values(sources))].join(' + '),warnings,errors,complete:errors.length===0,keywordCount:value.keywords.length,duplicates};
}
export async function inspectSourceMetadata(project,options={}){const extracted=await readSourceMetadata(project);return {...resolveMetadata(extracted,null,options),extracted};}
