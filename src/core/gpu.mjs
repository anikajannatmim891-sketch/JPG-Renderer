export function installGPUTracking() {
  const devices = new Map();
  const queues = new WeakMap();
  const adapterRequest = globalThis.GPUAdapter?.prototype.requestDevice;
  const adapterInfo = adapter=>{
    const info=adapter.info;
    return {vendor:info?.vendor,architecture:info?.architecture,device:info?.device,
      description:info?.description,software:info?.isFallbackAdapter === true ||
        /swiftshader|llvmpipe|software|lavapipe|warp/i.test([info?.vendor,info?.architecture,info?.description].join(' '))};
  };
  if (adapterRequest) {
    GPUAdapter.prototype.requestDevice = async function(...args) {
      const device = await adapterRequest.apply(this,args);
      const report = {...adapterInfo(this),maxTextureDimension2D:device.limits.maxTextureDimension2D,
        maxBufferSize:device.limits.maxBufferSize,maxStorageBufferBindingSize:device.limits.maxStorageBufferBindingSize,
        submissions:0,errors:[],lost:null};
      devices.set(device,report);
      queues.set(device.queue,report);
      device.addEventListener('uncapturederror',event=>{
        if (report.errors.length<8) report.errors.push(event.error.message);
      });
      void device.lost.then(loss=>{report.lost = loss.reason === 'destroyed' ? 'destroyed' : loss.message || loss.reason;});
      return device;
    };
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function(...args) {
      const result = submit.apply(this,args);
      const device = queues.get(this);
      if (device) device.submissions++;
      return result;
    };
  }
  const surfaces = new WeakMap();
  const gpuCanvas = globalThis.GPUCanvasContext?.prototype;
  if (gpuCanvas) {
    const configure = gpuCanvas.configure;
    const texture = gpuCanvas.getCurrentTexture;
    gpuCanvas.configure = function(options) {
      const result = configure.call(this,options);
      surfaces.set(this.canvas,{configured:true,limit:options.device.limits.maxTextureDimension2D});
      return result;
    };
    gpuCanvas.getCurrentTexture = function() {
      const result = texture.call(this);
      const surface = surfaces.get(this.canvas);
      if (surface) Object.assign(surface,{width:result.width,height:result.height});
      return result;
    };
  }
  const transferred = new WeakSet();
  const transfer = HTMLCanvasElement.prototype.transferControlToOffscreen;
  if (transfer) HTMLCanvasElement.prototype.transferControlToOffscreen = function(...args) {
    const result = transfer.apply(this,args);
    transferred.add(this);
    return result;
  };
  const offscreen = new Set();
  const getContext = globalThis.OffscreenCanvas?.prototype.getContext;
  if (getContext) OffscreenCanvas.prototype.getContext = function(type,...args) {
    const context = getContext.call(this,type,...args);
    if (context) offscreen.add(type);
    return context;
  };
  Object.defineProperties(globalThis,{
    __uvrsSurface:{value:canvas=>surfaces.get(canvas)},
    __uvrsOffscreen:{value:canvas=>transferred.has(canvas)},
    __uvrsOffscreenTypes:{value:()=>Array.from(offscreen)},
    __uvrsGPU:{value:async (wait=false)=>{
      if (wait) await Promise.all([...devices].filter(([,data])=>!data.lost).map(([device])=>device.queue.onSubmittedWorkDone()));
      return [...devices.values()];
    }},
  });
}

export async function probeWebGPU() {
  if (!navigator.gpu) return {operational:false,error:'WebGPU is unavailable in this Chromium context'};
  let device;
  try {
    const adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if (!adapter) return {operational:false,error:'Chromium did not supply a WebGPU adapter'};
    device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const input = device.createBuffer({size:4,usage:GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
    const output = device.createBuffer({size:4,usage:GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    const texture = device.createTexture({size:[2,2],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT});
    device.queue.writeBuffer(input,0,new Uint32Array([0x75667273]));
    const encoder = device.createCommandEncoder();
    encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),clearValue:[.3,.4,.5,1],loadOp:'clear',storeOp:'store'}]}).end();
    encoder.copyBufferToBuffer(input,0,output,0,4);
    device.queue.submit([encoder.finish()]);
    await output.mapAsync(GPUMapMode.READ);
    const valid = new Uint32Array(output.getMappedRange())[0]===0x75667273;
    output.unmap();
    const error = await device.popErrorScope();
    if (!valid || error) throw new Error(error?.message || 'GPU command readback did not match the probe');
    const [info] = (await globalThis.__uvrsGPU()).slice(-1);
    return {operational:true,...info,features:[...adapter.features].sort()};
  } catch(error) {
    return {operational:false,error:error.message};
  } finally {device?.destroy();}
}

export function reportWebGPU(devices, {requireHardware=false}={}) {
  const active = devices.filter(device=>device.lost !== 'destroyed');
  if (!active.length) throw new Error('WebGPU canvas has no observable active GPUDevice');
  for (const device of active) {
    if (device.lost) throw new Error('WebGPU device lost: '+device.lost);
    if (device.errors.length) throw new Error('WebGPU validation: '+device.errors.join(' · '));
  }
  const submitted = active.filter(device=>device.submissions>0);
  if (!submitted.length) throw new Error('WebGPU artwork submitted no GPU work');
  if (requireHardware && submitted.some(device=>device.software || !device.vendor || !device.architecture))
    throw new Error('Hardware-only policy: the WebGPU artwork adapter is software or unverified');
  return submitted;
}
