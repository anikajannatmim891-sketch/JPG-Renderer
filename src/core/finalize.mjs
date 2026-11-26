import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {embedAndVerify,pixelDigest,readEmbeddedMetadata} from './metadata-tool.mjs';
import {inspectRaster} from './validation.mjs';
import {metadataDefaults,resolveMetadata} from './metadata.mjs';

async function publish(working, output, metadata, validation, signal, key) {
  // The visible file is linked only after QA. A same-volume staging file is
  // required even when the queue database lives on another disk.
  const staging = path.join(path.dirname(output),'.uvrs-publish-' + key);
  try {
    await fs.copyFile(working,staging);
    const handle = await fs.open(staging,'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    if (signal?.aborted) throw new Error('Cancelled');
    try { await fs.link(staging,output); }
    catch(error) {
      if (error.code !== 'EEXIST') throw error;
      // An interruption can happen between linking and saving the job state.
      // Independently verify that the existing path contains the same export.
      const info = await fs.lstat(output);
      if (!info.isFile() || info.size !== validation.bytes)
        throw new Error('Output already exists and differs from this export: ' + output);
      if (metadata.complete) {
        const [existing,pixels] = await Promise.all([
          readEmbeddedMetadata(output,{signal}),pixelDigest(output),
        ]);
        if (JSON.stringify(existing.tags) !== JSON.stringify(metadata.readback.tags) || pixels !== metadata.pixelDigest)
          throw new Error('Output already exists and differs from this export: ' + output);
      } else {
        const existing = await fs.readFile(output);
        if (crypto.createHash('sha256').update(existing).digest('hex') !== validation.hash)
          throw new Error('Output already exists and differs from this export: ' + output);
      }
    }
  } finally { await fs.rm(staging,{force:true}).catch(()=>{}); }
}

export async function finalizeEncoded({encoded,output,settings,metadata,metadataOptions={},signal,history=[],onProgress}) {
  const config = {...metadataDefaults,...metadataOptions};
  const extension = settings.format === 'jpeg' ? 'jpg' : settings.format;
  const key = path.basename(encoded,path.extname(encoded));
  const working = path.join(path.dirname(encoded),'.tags-' + key + '.' + extension);
  try {
    await fs.copyFile(encoded,working);
    let embedded;
    if (config.enabled) {
      onProgress?.({phase:'metadata',message:'Embedding XMP and IPTC and reopening the JPEG'});
      embedded = await embedAndVerify(working,metadata,{format:settings.format,signal});
    } else {
      if (!config.allowWithout) throw new Error('Export without metadata requires explicit approval');
      embedded = {status:config.preview ? 'preview-only' : 'omitted-by-approval',complete:false,
        intended:metadata?.value || null,warnings:['Embedded metadata omitted by approval']};
    }
    if (signal?.aborted) throw new Error('Cancelled');
    onProgress?.({phase:'verifying',message:'Verifying decoded pixels, profile and output limits'});
    const validation = await inspectRaster(working,settings,history);
    validation.warnings.push(...embedded.warnings);
    if (validation.errors.length) throw new Error(validation.errors.join('; '));
    await publish(working,output,embedded,validation,signal,key);
    return {metadata:embedded,validation};
  } finally {await fs.rm(working,{force:true}).catch(()=>{});}
}

export async function retryEncodedMetadata(options) {
  const r = options.recovery;
  if (!r?.encoded || !r.output) throw new Error('No encoded image is retained for metadata retry');
  const metadataOptions = {...r.metadataOptions,...options.metadata,
    overrides:{...r.metadataOptions?.overrides,...options.metadata?.overrides}};
  const metadata = resolveMetadata(r.extracted,r.runtime,metadataOptions);
  try {
    if (metadataOptions.enabled && !metadata.complete) {
      const error = new Error('Metadata needs review: ' + metadata.errors.join('; '));
      error.needsReview = true;
      throw error;
    }
    const completed = await finalizeEncoded({encoded:r.encoded,output:r.output,settings:r.settings,metadata,metadataOptions,
      signal:options.signal,history:options.history,onProgress:options.onProgress});
    const logs = [...(r.logs || [])];
    if (!options.initial) logs.push({level:'metadata',message:'Metadata-only retry; source was not rendered again'});
    completed.validation.warnings.push(...(r.warnings || []));
    const result = {output:r.output,requested:r.requested,actual:r.actual,source:r.source,settings:r.settings,gpu:r.gpu,
      runtimeMetadata:r.runtime,detected:r.detected,backend:r.backend,strategy:r.strategy,
      recovered:!options.initial || r.recovered,logs,durationMs:Date.now()-(r.started || Date.now()),...completed};
    if (r.writeManifest !== false && options.writeManifest !== false)
      await fs.writeFile(r.output+'.json',JSON.stringify(result,null,2),{flag:'wx'}).catch(error=>{
        completed.validation.warnings.push('Technical manifest could not be saved: ' + error.message);
      });
    if (!options.onCheckpoint) {
      await fs.rm(r.encoded,{force:true}).catch(()=>{});
      await fs.rmdir(r.workspace || path.dirname(r.encoded)).catch(()=>{});
    }
    return result;
  } catch(error) {
    error.metadataFailure = true;
    error.recovery = {...r,metadataOptions};
    throw error;
  }
}
