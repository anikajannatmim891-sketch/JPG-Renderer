import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {inspectProject,serveProject} from './project.mjs';
import {validateSettings,defaults} from './validation.mjs';
import {readSourceMetadata,resolveMetadata,metadataDefaults} from './metadata.mjs';
import {finalizeEncoded,retryEncodedMetadata} from './finalize.mjs';
export async function gpuProbe(page) {
  return page.evaluate(async()=>{
    const canvas=document.createElementNS('http://www.w3.org/1999/xhtml','canvas');
    const gl=canvas.getContext('webgl2')||canvas.getContext('webgl');
    let result={webgl:false,webgl2:false,webgpu:!!navigator.gpu,renderer:'Unavailable',software:false};
    if(gl){
      const debug=gl.getExtension('WEBGL_debug_renderer_info');
      const renderer=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
      const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,64,64,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      const fbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
      result={...result,webgl:true,webgl2:gl instanceof WebGL2RenderingContext,renderer,software:/swiftshader|llvmpipe|software|lavapipe/i.test(renderer),maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE),maxRenderbufferSize:gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),maxViewport:gl.getParameter(gl.MAX_VIEWPORT_DIMS),framebufferProbeComplete:gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE,extensions:gl.getSupportedExtensions(),memory:'Browser does not expose reliable available GPU memory'};
      gl.deleteFramebuffer(fbo);gl.deleteTexture(texture);gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    if(navigator.gpu) {try{const adapter=await navigator.gpu.requestAdapter();result.webgpu=!!adapter;result.webgpuInfo=adapter?{...adapter.info}:null;}catch{result.webgpu=false;}}
    return result;
  });
}
export async function renderArtwork(options) {
  if(options.recovery)return retryEncodedMetadata(options);
  const s={...defaults,...options.settings};validateSettings(s);
  const metadataOptions={...metadataDefaults,...options.metadata};
  let runtime,extracted,gpu,captured;
  const signal=options.signal;
  const check=()=>{if(signal?.aborted) throw new Error('Cancelled');};check();
  const started=Date.now(), logs=[],warnings=[];
  const log=(level,message)=>{if(logs.length<250)logs.push({level,message:String(message).slice(0,3000)});options.onProgress?.({phase:level,message});};
  const project=await inspectProject(options.source);
  extracted=await readSourceMetadata(project);
  const server=await serveProject(project);
  let browser,temporary,output;
  let deadlineExpired=false;
  const deadline=setTimeout(()=>{deadlineExpired=true;browser?.close().catch(()=>{});},Math.min(600000,Math.max(30000,s.timeout*5)));
  let aborted=()=>browser?.close().catch(()=>{});
  signal?.addEventListener('abort',aborted,{once:true});
  try {
    log('loading','Starting dedicated Chromium worker');
    browser=await chromium.launch({channel:'chromium',headless:true,executablePath:process.env.UVRS_CHROMIUM||undefined,args:process.env.UVRS_SOFTWARE_TEST==='1'?['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']:[]});
    check();
    const ratio=s.width/s.designWidth;
    const cssHeight=s.height/ratio;
    if(!Number.isInteger(cssHeight)) throw new Error('Target aspect ratio must produce an integer design height. Adjust design width.');
    const context=await browser.newContext({viewport:{width:s.designWidth,height:cssHeight},deviceScaleFactor:ratio,acceptDownloads:false,serviceWorkers:'block',javaScriptEnabled:true});
    const page=await context.newPage();page.setDefaultTimeout(s.timeout);
    const failures=[];
    await context.route('**/*',async route=>{
      const u=new URL(route.request().url());
      const local=u.origin===server.origin&&u.pathname.startsWith(new URL(server.base).pathname);
      const allowed=s.allowedOrigins.includes(u.origin)&&u.protocol==='https:';
      if(local||allowed||['data:','blob:'].includes(u.protocol)) await route.continue();
      else{failures.push('Blocked dependency: '+u.origin+u.pathname);await route.abort('blockedbyclient');}
    });
    // WebSockets are a separate network path from HTTP requests.
    await context.routeWebSocket('**/*',socket=>socket.close({code:1008,reason:'WebSockets disabled during offline rendering'}));
    context.on('page',p=>{if(p!==page)p.close().catch(()=>{});});
    page.on('dialog',d=>d.dismiss().catch(()=>{}));
    page.on('console',m=>{if(['warning','error'].includes(m.type()))log(m.type(),m.text());});
    page.on('pageerror',e=>failures.push('JavaScript: '+e.message));
    page.on('requestfailed',r=>failures.push('Asset failed: '+r.url().replace(server.base,'project/')));
    page.on('response',r=>{if(r.status()>=400)failures.push(`HTTP ${r.status()}: ${r.url().replace(server.base,'project/')}`);});
    await page.goto(server.url,{waitUntil:'load',timeout:s.timeout});
    if(project.kind==='svg')await page.evaluate(({width,height})=>{const svg=document.documentElement;if(svg.tagName.toLowerCase()!=='svg')throw new Error('Invalid standalone SVG');const box=svg.viewBox.baseVal;const w=box.width||svg.width.baseVal.value,h=box.height||svg.height.baseVal.value;if(!w||!h)throw new Error('SVG requires dimensions or a viewBox');if(Math.abs(w/h-width/height)>.001)throw new Error('SVG aspect ratio differs from output. Choose matching dimensions to avoid stretching, cropping or borders.');if(!box.width)svg.setAttribute('viewBox',`0 0 ${w} ${h}`);svg.setAttribute('width',String(width));svg.setAttribute('height',String(height));},{width:s.designWidth,height:cssHeight});
    await page.evaluate(async()=>{
      await document.fonts.ready;
      if([...document.fonts].some(f=>f.status==='error'))throw new Error('A required font failed to load');
      await Promise.all([...document.images].map(async img=>{if(!img.complete)await new Promise((resolve,reject)=>{img.addEventListener('load',resolve,{once:true});img.addEventListener('error',()=>reject(new Error('Image failed: '+img.getAttribute('src'))),{once:true});});if(!img.naturalWidth)throw new Error('Image failed: '+img.getAttribute('src'));await img.decode();}));
    });
    // Quiescence is event-based, with a bounded timeout; never a fixed capture delay.
    await page.waitForLoadState('networkidle',{timeout:s.timeout});check();
    const contract=await page.evaluate(()=>({exists:!!window.renderStudio,render:typeof window.renderStudio?.render==='function',tiles:window.renderStudio?.capabilities?.tiles===true,version:window.renderStudio?.version}));
    if(project.manifest.readiness==='explicit'&&!contract.render)throw new Error('Manifest requires window.renderStudio.render');
    if(contract.exists && (contract.version!==1||!contract.render))throw new Error('Unsupported render contract; expected version: 1 and render()');
    if(!contract.render && s.time!==0)throw new Error('Fixed-time rendering requires the renderStudio contract');
    if(s.strategy==='tiled'&&!contract.tiles)throw new Error('Tiling requires explicit renderStudio.capabilities.tiles. Arbitrary webpages are not stitchable.');
    if(contract.render)await page.evaluate(async()=>{const c=window.renderStudio;if(typeof c.ready==='function')await c.ready();else if(c.ready)await c.ready;});
    gpu=await gpuProbe(page);log('capability',JSON.stringify(gpu));
    const hasCanvas=await page.locator('canvas').count();
    if(s.strategy==='direct'&&hasCanvas&&gpu.maxTextureSize&&Math.max(s.width,s.height)>gpu.maxTextureSize)throw new Error(`Requested Canvas dimensions exceed the verified ${gpu.maxTextureSize}px texture limit. Use explicit-contract tiling; direct capture is unsafe on this backend.`);
    const renderFrame=async(tile)=>{
      check();
      if(contract.render)await page.evaluate(async args=>{
        await window.renderStudio.render(args);
        await new Promise(r=>requestAnimationFrame(()=>r()));
        for(const canvas of document.querySelectorAll('canvas')){
          const gl=canvas.getContext('webgl2')||canvas.getContext('webgl');if(gl){gl.finish();if(gl.isContextLost())throw new Error('WebGL context lost');}
        }
      },{width:s.width,height:s.height,cssWidth:s.designWidth,cssHeight,pixelRatio:ratio,time:s.time,seed:s.seed,tile});
      else {
        const animations=await page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').length);
        if(animations)throw new Error('Running CSS/SVG animation requires the deterministic render contract to select and pause a frame');
        await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      }
      const canvases=await page.evaluate(()=>[...document.querySelectorAll('canvas')].map(c=>{
        const rect=c.getBoundingClientRect();let gl=null;try{gl=c.getContext('webgl2')||c.getContext('webgl');}catch{}
        return {width:c.width,height:c.height,cssWidth:rect.width,cssHeight:rect.height,webgl:!!gl,bufferWidth:gl?.drawingBufferWidth,bufferHeight:gl?.drawingBufferHeight};
      }));
      for(const c of canvases){
        if(c.width+1<c.cssWidth*ratio||c.height+1<c.cssHeight*ratio)throw new Error(`Canvas backing store ${c.width}×${c.height} is below effective resolution. Implement renderStudio.render and size the backing store using pixelRatio.`);
        if(c.webgl){if(gpu.software&&!s.allowSoftware)throw new Error('Software WebGL detected. Enable software rendering explicitly or use a verified hardware GPU.');if(!gpu.webgl||c.bufferWidth!==c.width||c.bufferHeight!==c.height)throw new Error('WebGL drawing buffer does not match requested canvas');}
      }
      if(failures.length)throw new Error([...new Set(failures)].slice(0,15).join('\n'));
    };
    log('rendering',`Rendering ${s.width} × ${s.height} native pixels`);
    let capture;
    if(s.strategy==='direct') {
      await renderFrame(null);
      if(project.manifest.selector){
        const rect=await page.locator(project.manifest.selector).boundingBox();
        if(!rect||Math.abs(rect.width-s.designWidth)>.1||Math.abs(rect.height-cssHeight)>.1)throw new Error('Artwork selector must match full design dimensions; implicit crop or stretching is disabled');
        capture=await page.locator(project.manifest.selector).screenshot({type:'png',omitBackground:s.transparent,timeout:s.timeout});
      }else capture=await page.screenshot({type:'png',omitBackground:s.transparent,timeout:s.timeout,fullPage:false});
    } else {
      const gcd=(a,b)=>b?gcd(b,a%b):a;
      const denominator=s.designWidth/gcd(s.width,s.designWidth);
      const overlapCss=Math.ceil(2/denominator)*denominator;
      const overlapPixels=Math.round(overlapCss*ratio);
      const maxCss=Math.min(512,Math.floor((gpu.maxTextureSize||4096)/ratio)-2*overlapCss);
      const tileCss=Math.floor(maxCss/denominator)*denominator;
      if(tileCss<1)throw new Error('Pixel ratio cannot form safe integral tiles; choose a different design width');
      const tilePixels=Math.round(tileCss*ratio);
      if(Math.abs(tilePixels-tileCss*ratio)>.0001)throw new Error('Tiling requires an integral pixel ratio × 512 to avoid rounding seams');
      const tiles=[];let count=0;
      for(let y=0;y<s.height;y+=tilePixels)for(let x=0;x<s.width;x+=tilePixels){
        const width=Math.min(tilePixels,s.width-x),height=Math.min(tilePixels,s.height-y);
        if(!Number.isInteger(width/ratio)||!Number.isInteger(height/ratio))throw new Error('Tile edge is not aligned with CSS pixels');
        const captureX=Math.max(0,x-overlapPixels),captureY=Math.max(0,y-overlapPixels);
        const captureWidth=Math.min(s.width,x+width+overlapPixels)-captureX,captureHeight=Math.min(s.height,y+height+overlapPixels)-captureY;
        await page.setViewportSize({width:captureWidth/ratio,height:captureHeight/ratio});
        await renderFrame({x:captureX,y:captureY,width:captureWidth,height:captureHeight,fullWidth:s.width,fullHeight:s.height,overlap:overlapPixels});
        const input=await page.screenshot({type:'png',omitBackground:s.transparent,timeout:s.timeout});
        const m=await sharp(input).metadata();if(m.width!==captureWidth||m.height!==captureHeight)throw new Error('Tile capture size mismatch');
        const cropped=await sharp(input).extract({left:x-captureX,top:y-captureY,width,height}).png().toBuffer();
        tiles.push({input:cropped,left:x,top:y});log('tile',`Captured tile ${++count}`);
      }
      capture=await sharp({create:{width:s.width,height:s.height,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(tiles).png().toBuffer();
      warnings.push('Explicit-contract tiles assembled with cropped overlap. Large screen-space filters require author-managed padding; inspect seams.');
    }
    captured=await sharp(capture,{limitInputPixels:300e6}).metadata();
    if(captured.width!==s.width||captured.height!==s.height)throw new Error(`Capture was ${captured.width}×${captured.height}, requested ${s.width}×${s.height}; no upscaling performed`);
    runtime=await page.evaluate(()=>{const raw=window.__UVRS_METADATA__;if(raw===undefined)return null;return JSON.parse(JSON.stringify(raw));});
    const metadata=resolveMetadata(extracted,runtime,metadataOptions);
    log('encoding','Encoding sRGB output and decoding for validation');
    const dir=await fs.realpath(options.destination);
    const stem=(options.name||path.basename(project.entry,path.extname(project.entry))).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80)||'artwork';
    const id=crypto.randomUUID();output=path.join(dir,`${stem}-${s.width}x${s.height}-${id.slice(0,8)}.${s.format==='jpeg'?'jpg':s.format}`);
    temporary=path.join(dir,`.uvrs-${id}.${s.format==='jpeg'?'jpg':s.format}`);
    let pipeline=sharp(capture,{limitInputPixels:300e6}).withIccProfile('srgb');
    if(s.format==='jpeg') pipeline=pipeline.flatten({background:'#ffffff'}).jpeg({quality:s.quality,chromaSubsampling:'4:4:4'});
    else if(s.format==='png')pipeline=pipeline.png({compressionLevel:9});else pipeline=pipeline.webp({quality:s.quality});
    await pipeline.toFile(temporary);check();
    const completed=await finalizeEncoded({encoded:temporary,output,settings:s,metadata,metadataOptions,signal,history:options.history,onProgress:options.onProgress});
    completed.validation.warnings.push(...warnings);
    await fs.unlink(temporary);temporary=null;
    const result={output,requested:{width:s.width,height:s.height},actual:{width:captured.width,height:captured.height},durationMs:Date.now()-started,gpu,runtimeMetadata:runtime,...completed,logs,source:project.file,settings:s};
    if(options.writeManifest!==false)await fs.writeFile(output+'.json',JSON.stringify(result,null,2),{flag:'wx'});
    return result;
  }catch(e){if(e.metadataFailure&&temporary&&!signal?.aborted){const retained=path.join(path.dirname(temporary),`.uvrs-recovery-${crypto.randomUUID()}.${s.format==='jpeg'?'jpg':s.format}`);await fs.rename(temporary,retained);temporary=null;e.recovery={encoded:retained,output,settings:s,metadataOptions,extracted,runtime,source:project.file,gpu,requested:{width:s.width,height:s.height},actual:{width:captured.width,height:captured.height}};}if(deadlineExpired)throw new Error('Render deadline exceeded; check author readiness/render promises');if(signal?.aborted)throw new Error('Cancelled');throw e;}
  finally {clearTimeout(deadline);signal?.removeEventListener('abort',aborted);if(temporary)await fs.unlink(temporary).catch(()=>{});await browser?.close().catch(()=>{});await server.close();}
}
