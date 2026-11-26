import {close, filenameHints} from './dimensions.mjs';

export function installCanvasTracking({fixed2D, shaderTile, offline} = {}) {
  if (offline) for (const name of ['RTCPeerConnection','webkitRTCPeerConnection']) {
    Object.defineProperty(globalThis,name,{value:undefined});
  }
  const records = new Map();
  const attributes = ['width', 'height'];
  const glMethods = {
    viewport(gl, args, native) {
      if (!shaderTile) return native.apply(gl, args);
      return native.call(gl, 0, 0, shaderTile.width, shaderTile.height);
    },
    shaderSource(gl, [shader, source], native) {
      if (gl.getShaderParameter(shader, gl.SHADER_TYPE) === gl.FRAGMENT_SHADER) {
        records.get(gl.canvas).fragment = source;
        if (shaderTile) {
          const y = shaderTile.fullHeight - shaderTile.y - shaderTile.height;
          source = source.replace(/\bgl_FragCoord\b/g,
            '(gl_FragCoord + vec4(' + shaderTile.x + '.0, ' + y + '.0, 0.0, 0.0))');
        }
      }
      return native.call(gl, shader, source);
    },
    getUniformLocation(gl, args, native) {
      const location = native.apply(gl, args);
      if (location) uniformNames.set(location, args[1]);
      return location;
    },
    uniform2f(gl, args, native) {
      const name = uniformNames.get(args[0]);
      if (name) records.get(gl.canvas).uniforms[name] = args.slice(1);
      if (shaderTile?.resolution === name && name)
        args = [args[0], shaderTile.fullWidth, shaderTile.fullHeight];
      return native.apply(gl, args);
    },
    uniform2fv(gl, args, native) {
      const name = uniformNames.get(args[0]);
      if (name && args.length === 2) records.get(gl.canvas).uniforms[name] = Array.from(args[1]);
      if (shaderTile?.resolution === name && name)
        args = [args[0], [shaderTile.fullWidth, shaderTile.fullHeight]];
      return native.apply(gl, args);
    },
    drawArrays(gl, args, native) {
      const record = records.get(gl.canvas);
      record.draws++;
      record.fullscreen = args[0] === gl.TRIANGLES && args[1] === 0 && [3,6].includes(args[2]);
      return native.apply(gl, args);
    },
  };
  const uniformNames = new WeakMap();
  for (const method of ['drawElements','createFramebuffer','createTexture','scissor','drawArraysInstanced','drawElementsInstanced']) {
    glMethods[method] = (gl, args, native) => {
      records.get(gl.canvas).complex = true;
      return native.apply(gl, args);
    };
  }
  for (const prototype of [globalThis.WebGLRenderingContext?.prototype, globalThis.WebGL2RenderingContext?.prototype].filter(Boolean)) {
    for (const [name, invoke] of Object.entries(glMethods)) {
      const native = Object.hasOwn(prototype, name) && prototype[name];
      if (native) prototype[name] = function (...args) {
        return records.has(this.canvas) ? invoke(this, args, native) : native.apply(this, args);
      };
    }
  }

  const canvasPrototype = HTMLCanvasElement.prototype;
  const dimensions = Object.fromEntries(attributes.map(key => [key, Object.getOwnPropertyDescriptor(canvasPrototype, key)]));
  const adapted = new WeakMap();
  const nativeGetContext = canvasPrototype.getContext;
  const nativeRect = Element.prototype.getBoundingClientRect;
  function resize(canvas, record) {
    for (const key of attributes) {
      const size = record.mode === 'shader' ? shaderTile[key] : fixed2D.tile?.[key] ?? Math.round(record[key] * fixed2D.ratio);
      if (dimensions[key].get.call(canvas) !== size) dimensions[key].set.call(canvas, size);
    }
    if (record.mode === '2d' && record.context) {
      const tile = fixed2D.tile;
      CanvasRenderingContext2D.prototype.setTransform.call(record.context,fixed2D.ratio,0,0,fixed2D.ratio,-(tile?.x || 0),-(tile?.y || 0));
    }
  }
  if (fixed2D || shaderTile) {
    for (const key of attributes) Object.defineProperty(canvasPrototype, key, {
      ...dimensions[key],
      get() {return adapted.get(this)?.[key] ?? dimensions[key].get.call(this);},
      set(value) {
        dimensions[key].set.call(this, value);
        const record = adapted.get(this);
        if (record) {
          record[key] = dimensions[key].get.call(this);
          resize(this, record);
        }
      },
    });
  }
  canvasPrototype.getContext = function (type, ...args) {
    const webgl = /^(?:experimental-)?webgl2?$/.test(type);
    let adapter = adapted.get(this);
    if (!adapter && !records.has(this)) {
      const rect = nativeRect.call(this);
      const fullDesign = Math.abs(rect.width - fixed2D?.width) < .05 && Math.abs(rect.height - fixed2D?.height) < .05;
      const logical = Object.fromEntries(attributes.map(key => [key, dimensions[key].get.call(this)]));
      if (webgl && shaderTile) {
        adapter = {mode:'shader', ...logical};
        args[0] = {...args[0], preserveDrawingBuffer:true};
      } else if (type === '2d' && fullDesign && attributes.every(key => logical[key] === fixed2D[key])) {
        adapter = {mode:'2d', ...logical};
      }
      if (adapter) { adapted.set(this, adapter); resize(this, adapter); }
    }
    const context = nativeGetContext.call(this, type, ...args);
    if (context && !records.has(this)) {
      records.set(this, {type, context, webgl, draws:0, uniforms:{}, adapted:adapter?.mode});
      if (adapter?.mode === '2d') {
        adapter.context = context;
        resize(this, adapter);
        // These methods use backing-store coordinates or absolute transforms,
        // which this fixed-coordinate adapter cannot reinterpret safely.
        for (const method of ['getImageData','putImageData','resetTransform','setTransform','reset','drawImage','createPattern','isPointInPath','isPointInStroke']) {
          if (context[method]) context[method] = () => { throw new Error('Fixed Canvas 2D adapter cannot safely translate ' + method); };
        }
        for (const name of ['shadowBlur','shadowOffsetX','shadowOffsetY']) {
          const property = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype,name);
          Object.defineProperty(context,name,{
            get:()=>property.get.call(context) / fixed2D.ratio,
            set:value=>{
              const physical = Number(value) * fixed2D.ratio;
              if (fixed2D.tile && Math.abs(physical) * (name === 'shadowBlur' ? 24 : 6) > fixed2D.tile.overlap)
                throw new Error('Canvas 2D shadow exceeds the verified tile padding');
              property.set.call(context,physical);
            },
          });
        }
        const filter = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype,'filter');
        if (filter) {
          const lengths = /(-?(?:\d+\.?\d*|\.\d+))px\b/gi;
          const scaled = (value,multiplier) => value.replace(lengths,(_match,n)=>Number(n)*multiplier + 'px');
          Object.defineProperty(context,'filter',{
            get:()=>scaled(filter.get.call(context),1/fixed2D.ratio),
            set:value=>{
              const text = String(value);
              if (fixed2D.tile && [...text.matchAll(lengths)].reduce((sum,m)=>sum+Math.abs(Number(m[1])),0) * fixed2D.ratio * 8 > fixed2D.tile.overlap)
                throw new Error('Canvas 2D filter exceeds the verified tile padding');
              if (/\b(?:url|calc|var)\(/i.test(text) || /\d(?:em|rem|vw|vh|cm|mm|in|pt|pc)\b/i.test(text))
                throw new Error('Fixed Canvas 2D adapter cannot safely translate this filter');
              filter.set.call(context,scaled(text,fixed2D.ratio));
            },
          });
        }
      }
    }
    return context;
  };
  Object.defineProperty(globalThis, '__uvrsCanvases', {value: () => [...document.querySelectorAll('canvas')].map(canvas => {
    const {context, ...record} = records.get(canvas) || {};
    const rect = nativeRect.call(canvas);
    const result = {...record, width:dimensions.width.get.call(canvas), height:dimensions.height.get.call(canvas),
      cssWidth:rect.width, cssHeight:rect.height, x:rect.x, y:rect.y};
    if (record.webgl) {
      context.finish();
      Object.assign(result, {bufferWidth:context.drawingBufferWidth, bufferHeight:context.drawingBufferHeight, lost:context.isContextLost()});
    }
    return result;
  })});
}

export function measureLayout(selector) {
  const rect = element => {
    const {x,y,width,height} = element.getBoundingClientRect();
    return {x,y,width,height,scrollWidth:element.scrollWidth,scrollHeight:element.scrollHeight};
  };
  const target = selector ? document.querySelector(selector) : document.querySelector('#artwork');
  const svg = document.querySelector('svg');
  let intrinsicSVG;
  if (svg) {
    const numeric = raw => /^\d+(?:\.\d+)?(?:px)?$/.test(raw || '') ? parseFloat(raw) : 0;
    const width = numeric(svg.getAttribute('width')), height = numeric(svg.getAttribute('height'));
    const vb = svg.viewBox.baseVal;
    if ((width && height) || (vb.width && vb.height)) intrinsicSVG = {width:width || vb.width, height:height || vb.height};
  }
  const scripts = [...document.scripts].filter(script => !script.src && (!script.type || /javascript|module/.test(script.type)))
    .map(script => script.textContent).join('\n');
  const constant = name => Number(scripts.match(new RegExp('\\b(?:const|let|var)\\s+' + name + '\\s*=\\s*(\\d+)\\s*(?=[,;\\n]|$)'))?.[1]);
  return {
    target:target && rect(target), selectorMissing:!!selector && !target,
    svg:svg && rect(svg), intrinsicSVG, rootSVG:document.documentElement.localName === 'svg',
    body:document.body && rect(document.body), html:rect(document.documentElement),
    canvases:globalThis.__uvrsCanvases?.() || [],
    contract:{exists:!!window.renderStudio, render:typeof window.renderStudio?.render === 'function',
      tiles:window.renderStudio?.capabilities?.tiles === true, version:window.renderStudio?.version,
      tilePadding:window.renderStudio?.capabilities?.tilePadding,
      threeViewOffset:window.renderStudio?.capabilities?.threeViewOffset === true, design:window.renderStudio?.design},
    constants:{width:constant('CW'),height:constant('CH')},
    fixed2DPattern:/\.width\s*=\s*CW\b/.test(scripts) && /\.height\s*=\s*CH\b/.test(scripts) &&
      !/\b(?:devicePixelRatio|pixelRatio|OffscreenCanvas)\b/.test(scripts),
  };
}

export function projectHint(project) {
  const m = project.manifest;
  const width = m.designWidth ?? m.cssWidth;
  const height = m.designHeight ?? m.cssHeight ?? (width * m.height / m.width);
  return integerBox({width,height}, 'project manifest') || filenameHints(project.entry);
}

function integerBox(box, source) {
  if (!box || ![box.width,box.height].every(n => n > 0 && n <= 16384 && close(n, Math.round(n)))) return null;
  return {width:Math.round(box.width),height:Math.round(box.height),source};
}
const sameBox = (a,b) => a && b && close(a.width,b.width) && close(a.height,b.height);

export function selectLayout(project, first, second) {
  const hint = projectHint(project);
  const declared = hint?.source === 'project manifest' && hint;
  const design = integerBox(first.contract.design, 'runtime contract');
  const fixed = (a,b,source) => sameBox(a,b) && integerBox(a,source);
  const artwork = fixed(first.target,second.target,'#artwork or manifest selector');
  const [initialCanvas] = first.canvases;
  // Canvas created by a deferred contract often still has the HTML default
  // dimensions. That transient box says nothing about the native design.
  const defaultCanvas = first.contract.render && initialCanvas?.cssWidth === 300 && initialCanvas?.cssHeight === 150 &&
    initialCanvas?.width === 300 && initialCanvas?.height === 150;
  const canvas = first.canvases.length === 1 && second.canvases.length === 1 && !defaultCanvas &&
    fixed({width:initialCanvas.cssWidth,height:initialCanvas.cssHeight},
      {width:second.canvases[0].cssWidth,height:second.canvases[0].cssHeight},'canvas CSS layout');
  const constants = integerBox(first.constants,'inline CW and CH');
  const svg = (first.rootSVG || first.svg) && integerBox(first.intrinsicSVG,'SVG intrinsic dimensions');
  const stableBody = fixed(first.body,second.body,'body CSS layout');
  const stableRoot = fixed(first.html,second.html,'root CSS layout');
  const stableSVG = first.svg && second.svg && fixed(first.svg,second.svg,'SVG CSS layout');
  const stable = artwork || canvas || (first.rootSVG && svg) || stableSVG || stableBody || stableRoot;
  const layout = (stable && (!declared || !sameBox(stable,declared)) ? stable : declared)
    || stable || design || constants || svg || hint;
  if (!layout) throw new Error('Artwork dimensions are ambiguous: no stable layout, intrinsic size, contract or filename dimensions were found');
  const conflicting = [declared,design,constants,hint].filter(candidate => candidate && !sameBox(candidate,layout));
  return {...layout, notes:conflicting.map(candidate =>
    'Used ' + layout.source + ' ' + layout.width + ' × ' + layout.height + ' over ' +
    candidate.source + ' ' + candidate.width + ' × ' + candidate.height)};
}

export function legacyShader(layout) {
  if (layout.canvases.length !== 1 || layout.contract.exists) return null;
  const [canvas] = layout.canvases;
  if (!canvas.webgl || canvas.lost || canvas.complex || canvas.draws !== 1 || !canvas.fullscreen ||
      !canvas.fragment?.includes('gl_FragCoord') || /\b(?:sampler\w*|texture\w*|gl_FragDepth|discard)\b/.test(canvas.fragment)) return null;
  const candidates = Object.entries(canvas.uniforms).filter(([name, value]) =>
    /^(?:u_?)?(?:i?resolution|size|rendersize|canvassize|screensize)$/i.test(name) &&
    value.length === 2 && value[0] > 0 && value[1] > 0);
  return candidates.length === 1 ? {resolution:candidates[0][0]} : null;
}
