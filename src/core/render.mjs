import {chromium} from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {inspectProject,serveProject} from './project.mjs';
import {defaults,validateSettings} from './validation.mjs';
import {readSourceMetadata,resolveMetadata,metadataDefaults} from './metadata.mjs';
import {finalizeEncoded,retryEncodedMetadata} from './finalize.mjs';
import {close,gcd,planDimensions,profiles,viewportFor} from './dimensions.mjs';
import {installCanvasTracking,measureLayout,selectLayout,projectHint,legacyShader} from './inspection.mjs';
import {installGPUTracking,probeWebGPU,reportWebGPU} from './gpu.mjs';
import {progressivePolicy,accumulate} from './progressive.mjs';

export async function gpuProbe(page) {
  const gpu = await page.evaluate(() => {
    const canvas = document.createElementNS('http://www.w3.org/1999/xhtml','canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const base = {webgl:false,webgl2:false,renderer:'Unavailable',software:false};
    if (!gl) return base;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,64,64,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    const result = {...base, webgl:true, webgl2:gl instanceof WebGL2RenderingContext, renderer,
      software:/swiftshader|llvmpipe|software|lavapipe/i.test(renderer), maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxRenderbufferSize:gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), maxViewport:Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS)),
      framebufferProbeComplete:gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE};
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(texture);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return result;
  });
  return {...gpu, availableSystemBytes:os.freemem(), gpuMemory:'Available VRAM is not exposed by Chromium'};
}

async function openArtwork(browser, server, s, viewport, adapters) {
  const context = await browser.newContext({viewport:{width:viewport.cssWidth,height:viewport.cssHeight},
    deviceScaleFactor:viewport.ratio,acceptDownloads:false,serviceWorkers:'block'});
  const failures = [];
  try {
    await context.addInitScript(installGPUTracking);
    await context.addInitScript(installCanvasTracking,{...adapters,offline:!s.allowedOrigins.length});
    await context.route('**/*',async route => {
      const u = new URL(route.request().url());
      const local = u.origin === server.origin && u.pathname.startsWith(new URL(server.base).pathname);
      const allowed = s.allowedOrigins.includes(u.origin) && u.protocol === 'https:';
      if (local || allowed || ['data:','blob:'].includes(u.protocol)) await route.continue();
      else {
        failures.push('Blocked dependency: ' + u.origin + u.pathname);
        await route.abort('blockedbyclient');
      }
    });
    await context.routeWebSocket('**/*',socket=>socket.close({code:1008,reason:'WebSockets disabled during offline rendering'}));
    const page = await context.newPage();
    context.on('page',p=>{if(p!==page)void p.close().catch(()=>{});});
    page.setDefaultTimeout(s.timeout);
    page.on('dialog',d=>void d.dismiss().catch(()=>{}));
    page.on('pageerror',e=>failures.push('JavaScript: ' + e.message));
    page.on('console',entry=>{
      if (entry.type()==='error' && /violates the following Content Security Policy|violates the following content security policy|content security policy.*blocked/i.test(entry.text()))
        failures.push('Blocked dependency: ' + entry.text());
    });
    page.on('requestfailed',r=>failures.push('Asset failed: ' + r.url().replace(server.base,'project/')));
    page.on('response',r=>{if(r.status()>=400)failures.push('HTTP ' + r.status() + ': ' + r.url().replace(server.base,'project/'));});
    await page.goto(server.url,{waitUntil:'load',timeout:s.timeout});
    await page.evaluate(async()=>{
      await document.fonts.ready;
      if ([...document.fonts].some(f => f.status === 'error')) throw new Error('A required font failed to load');
      await Promise.all([...document.images].map(img=>img.decode()));
    });
    await page.waitForLoadState('networkidle',{timeout:s.timeout});
    const ensureLoaded = () => {
      if (failures.length) throw new Error([...new Set(failures)].slice(0,12).join('\n'));
    };
    ensureLoaded();
    return {page,context,ensureLoaded};
  } catch (error) {
    await context.close().catch(()=>{});
    throw error;
  }
}

function checkContract(project, contract, s) {
  if (contract.exists && (!contract.render || ![1,2].includes(contract.version)))
    throw new Error('Unsupported render contract; expected version 1 or 2 and render()');
  progressivePolicy(contract,s);
  if ((project.manifest.readiness === 'explicit' || s.time !== 0) && !contract.render)
    throw new Error('An explicit renderStudio contract is required for the requested readiness or time');
}

async function frame(page, contract, args, settings, check, report) {
  const progressive = progressivePolicy(contract,settings);
  await page.evaluate(async ({contract,args})=>{
    if (!contract.render) {
      if (document.getAnimations().some(a=>a.playState==='running'))
        throw new Error('Running animations require a deterministic renderStudio contract');
      return;
    }
    const studio = window.renderStudio;
    if (args.tile && contract.threeViewOffset) {
      const camera = studio.threeCamera;
      if (typeof camera?.setViewOffset!=='function' || typeof camera.clearViewOffset!=='function' || camera.view?.enabled)
        throw new Error('Three.js tile adapter requires an exposed camera without a pre-existing view offset');
      const tile=args.tile;
      camera.setViewOffset(tile.fullWidth,tile.fullHeight,tile.x,tile.y,tile.width,tile.height);
    }
    if (args.tile && contract.version===2) await studio.beginTile?.(args);
    await studio.render(args);
  },{contract,args});
  const samples = await accumulate(page,progressive,args,check,(done,minimum,maximum)=>{
    report('sampling','Completed '+done+' samples · target '+minimum+(maximum!==minimum?' · budget '+maximum:''),
      Math.min(1,done/(progressive.requireConvergence?maximum:minimum)),{samples:done});
  });
  await page.evaluate(async ({contract,args})=>{
    if (contract.version===2) await window.renderStudio?.flush?.(args);
    try {await globalThis.__uvrsGPU?.(true);}
    catch(error) {throw new Error('WebGPU device or presentation queue failed: '+error.message);}
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  },{contract,args});
  return samples;
}

async function finishFrame(page,contract,args) {
  if (!args.tile) return;
  await page.evaluate(async ({contract,args})=>{
    if (contract.version===2) await window.renderStudio?.endTile?.(args);
    if (contract.threeViewOffset) window.renderStudio.threeCamera.clearViewOffset();
  },{contract,args});
}

async function webGPUProbe(browser,server) {
  const context = await browser.newContext({serviceWorkers:'block'});
  try {
    await context.addInitScript(installGPUTracking);
    const page = await context.newPage();
    await page.goto(server.base+'__uvrs_probe');
    return await page.evaluate(probeWebGPU);
  } finally {await context.close();}
}

function gpuKind(layout) {
  const types = [...layout.canvases.map(c=>c.type),...layout.offscreen];
  const webgpu = types.includes('webgpu') || /webgpu|wgsl|tsl/i.test(layout.contract.engine || '');
  const webgl = types.some(type=>/webgl/i.test(type || '')) || (!webgpu && /webgl|path.?trac/i.test(layout.contract.engine || ''));
  return {webgpu,webgl};
}

async function setSVGViewport(page, viewport) {
  await page.evaluate(({cssWidth,cssHeight}) => {
    const svg = document.documentElement;
    const box = svg.viewBox.baseVal;
    const w = box.width || svg.width.baseVal.value;
    const h = box.height || svg.height.baseVal.value;
    if (!w || !h || Math.abs(w * cssHeight - h * cssWidth) > 0.01)
      throw new Error('SVG intrinsic aspect ratio differs from the selected viewport');
    if (!box.width) svg.setAttribute('viewBox','0 0 ' + w + ' ' + h);
    svg.setAttribute('width',String(cssWidth));
    svg.setAttribute('height',String(cssHeight));
  },viewport);
}

function assertLayout(layout, {cssWidth,cssHeight}, project) {
  if (layout.selectorMissing) throw new Error('Manifest artwork selector did not match an element');
  const canvas = layout.canvases.length === 1 && layout.canvases[0];
  const target = layout.target || (canvas && canvas.cssWidth && canvas.cssHeight && {
    x:canvas.x,y:canvas.y,width:canvas.cssWidth,height:canvas.cssHeight,
  });
  if (target && (target.x < -.1 || target.y < -.1 || target.x + target.width > cssWidth + .1 ||
      target.y + target.height > cssHeight + .1))
    throw new Error('Artwork extends outside its design viewport; capture would clip it');
  if (layout.target && (!close(layout.target.width,cssWidth,.1) || !close(layout.target.height,cssHeight,.1)))
    throw new Error('Artwork container does not fill the selected design viewport');
  if (project.kind !== 'svg' && (layout.html.scrollWidth > cssWidth + 1 || layout.html.scrollHeight > cssHeight + 1))
    throw new Error('Page content overflows its design viewport');
}

function assertCanvases(canvases, s, ratio, gpu) {
  for (const c of canvases) {
    if (!c.cssWidth || !c.cssHeight) continue;
    if (c.width + 1 < c.cssWidth * ratio || c.height + 1 < c.cssHeight * ratio)
      throw new Error('Canvas backing store ' + c.width + '×' + c.height + ' is below effective resolution');
    if (c.webgl) {
      if (!s.allowSoftware && (gpu.software || !gpu.webgl || !gpu.renderer || gpu.renderer==='Unavailable')) throw new Error('Software WebGL detected. Enable it explicitly or use a hardware GPU.');
      if (c.lost || c.bufferWidth !== c.width || c.bufferHeight !== c.height)
        throw new Error('WebGL drawing buffer does not match requested canvas, or context was lost');
    }
  }
}

function tilePlan(s, viewport, gpu, contract) {
  const {ratio,cssWidth} = viewport;
  const alignment = cssWidth / gcd(s.width,cssWidth);
  const padding = contract.tilePadding ?? 2;
  if (!Number.isFinite(padding) || padding < 0 || padding > 512) throw new Error('Invalid contract tilePadding');
  const overlapCss = Math.ceil(padding / alignment) * alignment;
  const overlap = Math.round(overlapCss * ratio);
  const limit = Math.min(gpu.maxRenderbufferSize || gpu.webgpu?.maxTextureDimension2D || 4096, gpu.webgpu?.maxTextureDimension2D || Infinity, ...(gpu.maxViewport || [Infinity]));
  const tileSize = contract.tileSize ?? 1024;
  if (!Number.isInteger(tileSize) || tileSize<16 || tileSize>1024) throw new Error('Invalid contract tileSize');
  const maxCss = Math.min(tileSize, Math.floor(limit / ratio) - 2 * overlapCss);
  const step = Math.round(Math.floor(maxCss / alignment) * alignment * ratio);
  if (!step) throw new Error('Pixel ratio and padding cannot form aligned tiles on this backend');
  return {step,overlap};
}

async function captureTiles(s, {step,overlap}, capture, report) {
  const count = Math.ceil(s.height/step) * Math.ceil(s.width/step);
  const tiles = [];
  for (let y=0; y<s.height; y+=step) for (let x=0; x<s.width; x+=step) {
    const width = Math.min(step,s.width-x), height = Math.min(step,s.height-y);
    const left = Math.max(0,x-overlap), top = Math.max(0,y-overlap);
    const tile = {x:left,y:top,width:Math.min(s.width,x+width+overlap)-left,
      height:Math.min(s.height,y+height+overlap)-top,fullWidth:s.width,fullHeight:s.height,overlap};
    const raw = await capture(tile);
    const meta = await sharp(raw).metadata();
    if (meta.width !== tile.width || meta.height !== tile.height) throw new Error('Tile capture size mismatch');
    tiles.push({input:await sharp(raw).extract({left:x-left,top:y-top,width,height}).png().toBuffer(),left:x,top:y});
    report('tile','Captured tile ' + tiles.length + ' of ' + count,tiles.length/count);
  }
  return sharp({create:{width:s.width,height:s.height,channels:4,background:'#00000000'}})
    .composite(tiles).png().toBuffer();
}

async function pixels(image) {
  return sharp(image).resize(64,64,{fit:'fill'}).ensureAlpha().raw().toBuffer();
}

async function verifyFrame(capture, diagnostic, s) {
  const final = await pixels(capture);
  const sample = diagnostic && await pixels(diagnostic);
  if (final.every((_,i)=>final[i-i%4+3] === 0)) throw new Error('Capture is completely transparent');
  if (final.every((value,i)=>i%4 === 3 || value === 0)) throw new Error('Capture is entirely black');
  const flat = (data, row, col) => {
    const baseline = (row * 64 + col) * 4;
    for (let y=row; y<row+16; y++) for (let x=col; x<col+16; x++) {
      const i = (y*64+x)*4;
      if ([0,1,2,3].some(k=>Math.abs(data[i+k]-data[baseline+k]) > 8)) return false;
    }
    return true;
  };
  if (sample) {
    if (!sample.some((v,i)=>i%4 === 3 && v) && final.every((v,i)=>v===final[i%4]))
      throw new Error('Blank capture and empty diagnostic frame');
    let changed = 0;
    for (let y=0;y<64;y+=16) for (let x=0;x<64;x+=16) {
      if (flat(final,y,x) && !flat(sample,y,x)) changed++;
    }
    if (changed) throw new Error('Capture contains ' + changed + ' unexpectedly uniform region(s) compared with the diagnostic frame');
  } else if (!s.transparent && final.every((v,i)=>v===final[i%4])) {
    throw new Error('Capture is uniform and has no diagnostic frame supporting it');
  }
}

async function encode(capture, file, s, metadata) {
  const floor = s.qualityFloor ?? s.quality;
  const maxBytes = s.profile ? profiles[s.profile].maxBytes : Infinity;
  const overhead = metadata?.complete ? Buffer.byteLength(JSON.stringify(metadata.value),'utf8') * 4 + 16384 : 0;
  for (let quality=s.quality;;quality=Math.max(floor,quality-3)) {
    let image = sharp(capture,{limitInputPixels:300e6}).withIccProfile('srgb');
    if (s.format === 'jpeg') image = image.flatten({background:'#ffffff'}).jpeg({quality,chromaSubsampling:'4:4:4'});
    else if (s.format === 'png') image = image.png({compressionLevel:9});
    else image = image.webp({quality});
    const {size} = await image.toFile(file);
    if (size + overhead <= maxBytes) return quality;
    if (quality === floor) throw new Error('JPEG exceeds the selected profile file-size limit at the quality floor');
  }
}

async function outputPath(dir, project, options, s) {
  const stem = (options.name || path.basename(project.entry,path.extname(project.entry)))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/,'').slice(0,95) || 'artwork';
  const extension = s.format === 'jpeg' ? 'jpg' : s.format;
  const root = stem + '-' + s.width + 'x' + s.height;
  if (options.output) return options.output;
  const preferred = path.join(dir,root + '.' + extension);
  if (options.autopilot) {
    try { await fs.access(preferred); } catch(error) { if (error.code === 'ENOENT') return preferred; throw error; }
  }
  return path.join(dir,root + '-' + (options.jobId || crypto.randomUUID()).slice(0,8) + '.' + extension);
}

export async function renderArtwork(options) {
  if (options.recovery) return retryEncodedMetadata(options);
  let s = {...defaults,...options.settings};
  if (!options.autopilot) validateSettings(s);
  const signal = options.signal;
  const check = () => {if(signal?.aborted) throw new Error('Cancelled');};
  check();
  const started = Date.now(), logs = [], warnings = [];
  const report = (phase,message,percent,data) => {
    if (logs.length < 120) logs.push({level:phase,message});
    options.onProgress?.({phase,message,percent,data});
  };
  const metadataOptions = {...metadataDefaults,...options.metadata};
  const project = await inspectProject(options.source);
  const extracted = await readSourceMetadata(project);
  const server = await serveProject(project,{offline:!s.allowedOrigins.length});
  let browser, encoded, scratch, committed = false, deadlineExpired = false;
  const interrupt = () => {void browser?.close().catch(()=>{});};
  const budgetMs = options.autopilot?.renderBudgetMs ?? Math.min(600000,Math.max(30000,s.timeout*8));
  const deadline = setTimeout(()=>{deadlineExpired=true;interrupt();},budgetMs);
  signal?.addEventListener('abort',interrupt,{once:true});
  try {
    report('analyzing','Starting isolated Chromium');
    browser = await chromium.launch({channel:'chromium',headless:true,chromiumSandbox:true,
      executablePath:process.env.UVRS_CHROMIUM || undefined,
      args:['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--dns-prefetch-disable',
        ...(process.env.UVRS_SOFTWARE_TEST === '1' ? ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] : []),
        ...(process.env.UVRS_WEBGPU_TEST === '1' ? ['--enable-unsafe-webgpu','--use-vulkan=swiftshader',
          '--enable-features=Vulkan,CDPScreenshotNewSurface','--use-angle=swiftshader','--enable-unsafe-swiftshader'] : [])]});
    check();
    const selector = project.manifest.selector;
    const measure = page => page.evaluate(measureLayout,selector);
    let detected, diagnostic, baseline, shader, gpu, runtime, singleCanvas, samples, verifiedWebGPU;
    if (options.autopilot) {
      const hint = projectHint(project);
      const probe = {cssWidth:hint?.width || 1200,cssHeight:hint?.height || 900,ratio:1};
      const first = await openArtwork(browser,server,s,probe);
      const next = await openArtwork(browser,server,s,{cssWidth:probe.cssWidth+37,cssHeight:probe.cssHeight+29,ratio:1});
      try { detected = selectLayout(project,await measure(first.page),await measure(next.page)); }
      finally {await Promise.all([first.context.close(),next.context.close()]);}
      s = {...s,...planDimensions(detected.width,detected.height,options.autopilot),profile:options.autopilot.profile || 'adobe',
        stock:profiles[options.autopilot.profile || 'adobe'].stock,format:profiles[options.autopilot.profile || 'adobe'].format,
        transparent:profiles[options.autopilot.profile || 'adobe'].format==='png',
        strategy:'auto',allowSoftware:!(options.autopilot.hardwareOnly ?? false),sampleLimit:options.autopilot.sampleLimit ?? 512};
      warnings.push(...detected.notes);
    }
    validateSettings(s);
    let viewport = viewportFor(s);
    const requested = {width:s.width,height:s.height};
    report('planned','Planned ' + s.width + ' × ' + s.height,0,{detected,planned:{width:s.width,height:s.height}});
    const readRuntime = page => page.evaluate(()=> {
      const raw = window.__UVRS_METADATA__;
      return raw == null ? null : JSON.parse(JSON.stringify(raw));
    });
    const prepare = async (vp,adapter) => {
      const worker = await openArtwork(browser,server,s,vp,adapter);
      try {
        if (project.kind === 'svg') await setSVGViewport(worker.page,vp);
        const layout = await measure(worker.page);
        checkContract(project,layout.contract,s);
        if (layout.contract.render) await worker.page.evaluate(async()=>{
          const contract=window.renderStudio;
          if (typeof contract.ready === 'function') await contract.ready();
          else if (contract.ready) await contract.ready;
        });
        const close = async ()=>{
          try {
            if (layout.contract.version===2 && !signal?.aborted) {
              await worker.page.evaluate(()=>Promise.race([
                Promise.resolve().then(()=>window.renderStudio?.dispose?.()),new Promise(resolve=>setTimeout(resolve,1200))
              ])).catch(()=>{});
            }
          } finally {await worker.context.close();}
        };
        return {...worker,layout,close};
      } catch(error) {await worker.context.close();throw error;}
    };
    const args = (width,height,pixelRatio,tile=null) => ({width,height,cssWidth:viewport.cssWidth,cssHeight:viewport.cssHeight,pixelRatio,
      time:project.manifest.time ?? s.time,seed:project.manifest.seed ?? s.seed,tile});
    if (options.autopilot) {
      const worker = await prepare({...viewport,ratio:1});
      try {
        const checking = !worker.layout.contract.progressive;
        if (checking) await frame(worker.page,worker.layout.contract,args(viewport.cssWidth,viewport.cssHeight,1),s,check,report);
        baseline = await measure(worker.page);
        assertLayout(baseline,viewport,project);
        worker.ensureLoaded();
        const kinds = gpuKind(baseline);
        if (kinds.webgl) gpu = await gpuProbe(worker.page);
        if (kinds.webgpu) {
          verifiedWebGPU = await webGPUProbe(browser,server);
          if (!verifiedWebGPU.operational) throw new Error('WebGPU probe failed: '+verifiedWebGPU.error);
          gpu = {...gpu,webgpu:verifiedWebGPU,renderer:verifiedWebGPU.description || verifiedWebGPU.architecture,
            software:!!gpu?.software || verifiedWebGPU.software,availableSystemBytes:os.freemem()};
        }
        if (gpu) gpu.estimatedFrameBytes = s.width * s.height * 24;
        const [canvas] = baseline.canvases;
        singleCanvas = baseline.canvases.length === 1 && close(canvas.x,0) && close(canvas.y,0) &&
          close(canvas.cssWidth,viewport.cssWidth) && close(canvas.cssHeight,viewport.cssHeight) &&
          await worker.page.evaluate(()=>[...document.body.children].every(e=>['CANVAS','SCRIPT','STYLE'].includes(e.tagName)));
        if (singleCanvas) shader = legacyShader(baseline);
        if (checking) diagnostic = await worker.page.screenshot({type:'png',omitBackground:true,timeout:s.timeout});
        runtime = await readRuntime(worker.page);
      } finally {await worker.close();}
    }
    const backend = baseline?.contract.engine || (baseline?.contract.threeViewOffset ? 'Three.js / WebGL' : baseline ? [...new Set(baseline.canvases.map(c=>c.type || 'Canvas'))].join(' + ') ||
      (baseline.rootSVG || baseline.svg ? 'SVG / DOM' : project.kind === 'tsx' || project.kind === 'jsx' ? 'React / DOM' : 'HTML / CSS') : project.kind);
    if (options.autopilot) report('backend',backend + (gpu?.webgl && baseline.canvases.some(c=>c.webgl) ? ' · ' + gpu.renderer : ''),0,{backend,gpu});
    const checkGPU = async (page,layout,width,height) => {
      const {webgl,webgpu} = gpuKind(layout);
      if (webgl && !s.allowSoftware && (!gpu?.webgl || gpu.software || gpu.renderer==='Unavailable'))
        throw new Error('Hardware-only policy: WebGL renderer is software or unverified');
      if (!webgpu) return;
      verifiedWebGPU ??= await webGPUProbe(browser,server);
      if (!verifiedWebGPU.operational) throw new Error('WebGPU probe failed: '+verifiedWebGPU.error);
      for (const canvas of layout.canvases.filter(c=>c.type==='webgpu' && c.cssWidth && c.cssHeight)) {
        if (!canvas.surface || canvas.surface.width!==canvas.width || canvas.surface.height!==canvas.height ||
            Math.max(canvas.width,canvas.height)>canvas.surface.limit)
          throw new Error('WebGPU canvas did not acquire a native-sized surface texture');
      }
      const devices = reportWebGPU(await page.evaluate(()=>globalThis.__uvrsGPU(true)),{requireHardware:!s.allowSoftware});
      if (devices.every(device=>Math.max(width,height)>device.maxTextureDimension2D))
        throw new Error('The rendered frame exceeds the observed WebGPU device texture limit');
      gpu = {...gpu,webgpu:{...verifiedWebGPU,devices},software:!!gpu?.software || devices.some(device=>device.software),
        availableSystemBytes:os.freemem(),renderer:devices[0].description || devices[0].architecture};
    };
    const checkMemory = (width,height,advanced) => {
      const available = os.freemem();
      const estimated = width*height*(advanced ? 24 : 12);
      if (available>0 && estimated>available*.65)
        throw new Error('Estimated native frame memory exceeds the available system memory budget');
    };
    const captureDirect = async fixed2D => {
      const worker = await prepare(viewport,{fixed2D});
      try {
        const layout = worker.layout;
        const webgl = Boolean((baseline && gpuKind(baseline).webgl) || gpuKind(layout).webgl);
        if (webgl || !options.autopilot) gpu ??= await gpuProbe(worker.page);
        if (options.autopilot && webgl && (Math.max(s.width,s.height) > Math.min(gpu.maxRenderbufferSize || Infinity,gpu.maxTextureSize || Infinity)
            || s.width > (gpu.maxViewport?.[0] || Infinity) || s.height > (gpu.maxViewport?.[1] || Infinity)))
          throw new Error('Full-frame WebGL dimensions exceed the probed rendering limits');
        checkMemory(s.width,s.height,webgl || !!verifiedWebGPU);
        const frameArgs = args(s.width,s.height,viewport.ratio);
        samples = await frame(worker.page,layout.contract,frameArgs,s,check,report);
        const rendered = await measure(worker.page);
        await checkGPU(worker.page,rendered,s.width,s.height);
        if (options.autopilot) assertLayout(rendered,viewport,project);
        assertCanvases(rendered.canvases,s,viewport.ratio,gpu || {});
        worker.ensureLoaded();
        runtime = await readRuntime(worker.page);
        if (selector) {
          const box = await worker.page.locator(selector).boundingBox();
          if (!box || !close(box.width,viewport.cssWidth,.1) || !close(box.height,viewport.cssHeight,.1))
            throw new Error('Artwork selector must match full design dimensions');
          return await worker.page.locator(selector).screenshot({type:'png',omitBackground:s.transparent,timeout:s.timeout});
        }
        return await worker.page.screenshot({type:'png',omitBackground:s.transparent,timeout:s.timeout});
      } finally {await worker.close();}
    };
    const captureContractTiles = async () => {
      const worker = await prepare(viewport);
      try {
        const {contract} = worker.layout;
        if (!contract.tiles) throw new Error('Tiling requires verified renderStudio.capabilities.tiles or a compatible fullscreen shader');
        if ((baseline && gpuKind(baseline).webgl) || !options.autopilot) gpu ??= await gpuProbe(worker.page);
        const out = await captureTiles(s,tilePlan(s,viewport,gpu || {},contract),async tile=>{
          check();
          await worker.page.setViewportSize({width:Math.round(tile.width / viewport.ratio),height:Math.round(tile.height / viewport.ratio)});
          checkMemory(tile.width,tile.height,!!gpu);
          const frameArgs = args(s.width,s.height,viewport.ratio,tile);
          try {
            const completed = await frame(worker.page,contract,frameArgs,s,check,report);
            if (completed!==null) samples = Math.min(samples ?? completed,completed);
            const rendered = await measure(worker.page);
            await checkGPU(worker.page,rendered,tile.width,tile.height);
            assertCanvases(rendered.canvases,s,viewport.ratio,gpu || {});
            worker.ensureLoaded();
            return await worker.page.screenshot({type:'png',omitBackground:s.transparent,timeout:s.timeout});
          } finally {await finishFrame(worker.page,contract,frameArgs).catch(()=>{});}
        },report);
        runtime = await readRuntime(worker.page);
        return out;
      } finally {await worker.close();}
    };
    const captureShaderTiles = async (target,ratio,edge=3072) => {
      const step = Math.min(edge,gpu.maxTextureSize,gpu.maxRenderbufferSize,...gpu.maxViewport);
      return captureTiles(target,{step,overlap:0},async tile=>{
        check();
        const worker = await prepare({...viewport,ratio},{shaderTile:{...tile,...shader}});
        try {
          const rendered = await measure(worker.page);
          const [canvas] = rendered.canvases;
          if (!canvas || canvas.lost || canvas.draws !== 1 || canvas.complex ||
              canvas.bufferWidth !== tile.width || canvas.bufferHeight !== tile.height)
            throw new Error('Legacy shader could not produce an intact tile');
          worker.ensureLoaded();
          const image = await worker.page.evaluate(()=>{
            const source=document.querySelector('canvas');
            const output=document.createElement('canvas');
            const width=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'width');
            // The source getters expose its original logical dimensions. The
            // tile dimensions are obtained from the tracked physical buffer.
            const info=globalThis.__uvrsCanvases()[0];
            width.set.call(output,info.bufferWidth);
            output.height=info.bufferHeight;
            output.getContext('2d').drawImage(source,0,0);
            return output.toDataURL().split(',')[1];
          });
          return Buffer.from(image,'base64');
        } finally {await worker.close();}
      },report);
    };

    const compareDiagnostic = async (probe,adapter) => {
      const [actual,original] = await Promise.all([pixels(probe),pixels(diagnostic)]);
      if (actual.reduce((total,value,i)=>total+Math.abs(value-original[i]),0)/actual.length > 5)
        throw new Error(adapter + ' did not match the original diagnostic composition');
    };
    const captureFixedTiles = async (target,ratio,step) => {
      // Expand every tile before drawing so its effects sample the same pixels
      // as a full-frame backing store. Keep the element's logical box intact.
      return captureTiles(target,{step,overlap:1024},async tile=>{
        check();
        const fixed2D = {width:viewport.cssWidth,height:viewport.cssHeight,ratio,tile};
        const worker = await prepare({...viewport,ratio},{fixed2D});
        try {
          const [canvas] = (await measure(worker.page)).canvases;
          if (canvas?.adapted !== '2d' || canvas.width !== tile.width || canvas.height !== tile.height)
            throw new Error('Fixed Canvas 2D did not initialize the verified tile backing store');
          worker.ensureLoaded();
          const image = await worker.page.evaluate(()=>document.querySelector('canvas').toDataURL().split(',')[1]);
          return Buffer.from(image,'base64');
        } finally {await worker.close();}
      },report);
    };
    const strategies = s.strategy === 'tiled' ? [['tiled contract',captureContractTiles]] : [['direct',captureDirect]];
    if (s.strategy === 'auto') {
      if (baseline?.fixed2DPattern && !baseline.contract.exists && baseline.canvases.length === 1 &&
          baseline.canvases[0].type === '2d') {
        if (singleCanvas && s.width * s.height > 33e6) strategies.push(['tiled fixed Canvas 2D',async()=>{
          const probe = await captureFixedTiles({width:viewport.cssWidth,height:viewport.cssHeight},1,896);
          await compareDiagnostic(probe,'Canvas 2D tiles');
          return captureFixedTiles(s,viewport.ratio,2400);
        }]);
        strategies.push(['fixed Canvas 2D',()=>captureDirect({width:viewport.cssWidth,height:viewport.cssHeight,ratio:viewport.ratio})]);
      }
      if (baseline?.contract.tiles) strategies.push(['tiled contract',captureContractTiles]);
      if (shader) strategies.push(['tiled fullscreen WebGL',async()=>{
        const probe = await captureShaderTiles({width:viewport.cssWidth,height:viewport.cssHeight},1,768);
        await compareDiagnostic(probe,'Shader tiles');
        return captureShaderTiles(s,viewport.ratio);
      }]);
    }
    let capture, captured, strategy, recovered = false;
    const errors = [];
    const tryStrategies = async () => {
      for (const [label,run] of strategies) {
        check();
        report('rendering','Rendering ' + s.width + ' × ' + s.height + ' using ' + label,0,{strategy:label});
        try {
          const image = await run();
          const size = await sharp(image,{limitInputPixels:300e6}).metadata();
          if (size.width !== s.width || size.height !== s.height) throw new Error('Capture dimensions differ from target; native capture is required');
          if (options.autopilot) await verifyFrame(image,diagnostic,s);
          capture = image; captured = size; strategy = label; recovered = errors.length > 0; return;
        } catch(error) {
          check();
          errors.push(label + ': ' + error.message);
          report('fallback',errors.at(-1));
        }
      }
    };
    await tryStrategies();
    if (!capture && options.autopilot?.allowLower && baseline?.canvases.some(c=>c.webgl)) {
      const max = Math.max(s.width,s.height);
      const limit = Math.min(Math.floor(max*.8),gpu.maxRenderbufferSize || 0,gpu.maxTextureSize || 0,...(gpu.maxViewport || [0]));
      if (limit > 0 && limit < max) {
        s = {...s,...planDimensions(viewport.cssWidth,viewport.cssHeight,{...options.autopilot,limitEdge:limit})};
        viewport = viewportFor(s);
        warnings.push('Native resolution lowered to ' + s.width + ' × ' + s.height + ' under the enabled fallback policy');
        await tryStrategies();
      }
    }
    if (!capture) throw new Error(errors.join('\n') || 'No compatible strategy produced a valid frame');
    if (samples!==null && samples!==undefined) report('sampled','Finished '+samples+' samples',1,{samples});
    await browser.close();
    browser = null;
    clearTimeout(deadline);
    const metadata = resolveMetadata(extracted,runtime,metadataOptions);
    report('encoding','Encoding native pixels as sRGB');
    const dir = await fs.realpath(options.destination);
    const output = await outputPath(dir,project,options,s);
    const available = await fs.statfs(dir).catch(()=>null);
    if (available && available.bavail*available.bsize < 3*s.width*s.height)
      throw new Error('Insufficient output disk space for the encoded image and publication files');
    scratch = options.workspace || await fs.mkdtemp(path.join(os.tmpdir(),'uvrs-encoded-'));
    await fs.mkdir(scratch,{recursive:true});
    encoded = path.join(scratch,(options.jobId || crypto.randomUUID()) + '.' + (s.format === 'jpeg' ? 'jpg' : s.format));
    s.quality = await encode(capture,encoded,s,metadata);
    const handle = await fs.open(encoded,'r+');
    try {await handle.sync();} finally {await handle.close();}
    capture = null;
    check();
    const receipt = {encoded,output,settings:s,metadataOptions,extracted,runtime,source:project.file,gpu:gpu || {},
      requested,actual:{width:captured.width,height:captured.height},
      detected,backend,strategy,samples,recovered,warnings,logs,started,workspace:scratch,autopilot:!!options.autopilot,writeManifest:options.writeManifest};
    await options.onCheckpoint?.(receipt);
    committed = true;
    return await retryEncodedMetadata({...options,recovery:receipt,initial:true});
  } catch(error) {
    if (/WebGPU device lost|WebGL drawing buffer .*context was lost|presentation queue failed|external Instance reference|Target page, context or browser has been closed/i.test(error.message))
      error.retryable = true;
    if (deadlineExpired) throw new Error('Render deadline exceeded; check author readiness/render promises');
    if (signal?.aborted && !error.recovery) throw new Error('Cancelled');
    throw error;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort',interrupt);
    if (encoded && !committed) await fs.unlink(encoded).catch(()=>{});
    if (scratch && !options.workspace) await fs.rmdir(scratch).catch(()=>{});
    await browser?.close().catch(()=>{});
    await server.close();
  }
}
