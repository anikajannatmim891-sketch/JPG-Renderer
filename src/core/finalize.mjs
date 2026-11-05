import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {embedAndVerify} from './metadata-tool.mjs';
import {inspectRaster} from './validation.mjs';
import {metadataDefaults,resolveMetadata} from './metadata.mjs';
export async function finalizeEncoded({encoded,output,settings,metadata,metadataOptions={},signal,history=[],onProgress}){
  const config={...metadataDefaults,...metadataOptions};
  const extension=settings.format==='jpeg'?'jpg':settings.format;
  const working=path.join(path.dirname(output),`.uvrs-tags-${crypto.randomUUID()}.${extension}`);
  let embedded;
  try{
    await fs.copyFile(encoded,working,1);
    try{
      if(config.enabled){onProgress?.({phase:'metadata',message:'Embedding metadata, then reopening the actual image for readback'});embedded=await embedAndVerify(working,metadata,{format:settings.format,signal});}
      else{if(!config.allowWithout)throw new Error('Export without metadata requires explicit approval');embedded={status:config.preview?'preview-only':'omitted-by-approval',complete:false,intended:metadata?.value||null,warnings:['Metadata omitted by explicit approval; this file is not metadata-complete']};}
    }catch(e){e.metadataFailure=true;throw e;}
    if(signal?.aborted)throw new Error('Cancelled');
    const validation=await inspectRaster(working,settings,history);
    validation.warnings.push(...embedded.warnings);
    if(validation.errors.length){const e=new Error(validation.errors.join('; '));e.metadataFailure=true;throw e;}
    if(signal?.aborted)throw new Error('Cancelled');
    await fs.link(working,output); // Atomic, same volume, no overwrite.
    return {metadata:embedded,validation};
  }finally{await fs.unlink(working).catch(()=>{});}
}
export async function retryEncodedMetadata(options){
  const r=options.recovery;
  if(!r?.encoded||!r?.output)throw new Error('No valid encoded image is retained for metadata retry');
  const start=Date.now();await fs.access(r.encoded);
  const metadataOptions={...r.metadataOptions,...options.metadata,overrides:{...r.metadataOptions?.overrides,...options.metadata?.overrides}};
  const metadata=resolveMetadata(r.extracted,r.runtime,metadataOptions);
  try{
    const completed=await finalizeEncoded({encoded:r.encoded,output:r.output,settings:r.settings,metadata,metadataOptions,signal:options.signal,history:options.history,onProgress:options.onProgress});
    const result={output:r.output,requested:r.requested,actual:r.actual,source:r.source,settings:r.settings,gpu:r.gpu,logs:[{level:'metadata',message:'Metadata-only retry; source was not rendered again'}],durationMs:Date.now()-start,...completed};
    await fs.writeFile(r.output+'.json',JSON.stringify(result,null,2),{flag:'wx'});
    await fs.unlink(r.encoded);return result;
  }catch(e){if(e.metadataFailure)e.recovery={...r,metadataOptions};throw e;}
}
