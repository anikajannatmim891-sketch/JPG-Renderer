import path from 'node:path';
import fs from 'node:fs/promises';
import {build} from 'esbuild';
import {parse} from 'parse5';

const direct = Object.freeze({
  three:'three/build/three.module.js',
  'three/webgpu':'three/build/three.webgpu.js',
  'three/tsl':'three/build/three.tsl.js',
  'three/addons/':'three/examples/jsm/',
  'three/examples/jsm/':'three/examples/jsm/',
});
const bundled = ['@babylonjs/core','@babylonjs/loaders','three-gpu-pathtracer','three-mesh-bvh'];
const dependencies = new Set(['three','@babylonjs/core','@babylonjs/loaders','three-gpu-pathtracer','three-mesh-bvh',
  'react','react-dom','scheduler','@react-three/fiber','react-reconciler','its-fine','zustand','suspend-react','maath',
  'use-sync-external-store','@babel/runtime','@webgpu/types','base64-js','buffer','ieee754','xatlas-web','fflate',
  'react-use-measure','tunnel-rat']);

function packageName(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0,2).join('/') : specifier.split('/')[0];
}

export function inside(base,file) {
  const relative = path.relative(base,file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..'+path.sep);
}

export function privatePath(relative) {
  return relative.split(path.sep).some(part=>part.startsWith('.') ||
    /^(?:credentials?|secrets?|service[-_]?account)(?:[._-]|$)/i.test(part));
}

export async function bundleGraphics({entry,root,packages,library}) {
  const result = await build({
    ...(entry ? {entryPoints:[entry]} : {stdin:{contents:'export * from '+JSON.stringify(library)+';',
      resolveDir:path.dirname(packages),sourcefile:'uvrs-dependency.js'}}),
    bundle:true,write:false,platform:'browser',format:'esm',jsx:'automatic',nodePaths:[packages],
    define:{'process.env.NODE_ENV':'"production"'},
    external:library && !['react','react/jsx-runtime'].includes(library) ? ['three','three/*','react','react/jsx-runtime'] : [],
    logLevel:'silent',loader:{'.glsl':'text','.vert':'text','.frag':'text','.wgsl':'text'},
    plugins:[{name:'artwork-import-boundary',setup(builder) {
      builder.onLoad({filter:/.*/},async args=>{
        const real = await fs.realpath(args.path);
        const relative = path.relative(packages,real);
        if (inside(packages,real) && dependencies.has(packageName(relative.split(path.sep).join('/')))) return;
        const local = path.relative(root,real);
        if (inside(root,real) && !privatePath(local) && !local.split(path.sep).includes('node_modules')) return;
        throw new Error('Bundled import is outside the project and approved graphics packages: '+path.basename(real));
      });
    }}],
  });
  return result.outputFiles[0].contents;
}

const editableCDNs = ['https://cdn.jsdelivr.net/npm/three@0.180.0/','https://unpkg.com/three@0.180.0/'];
function approvedThreePath(relative) {
  return /^(?:three\/build\/(?:three\.[\w.]+\.js)|three\/examples\/jsm\/[\w./-]+)$/.test(relative) &&
    !relative.split('/').some(part=>!part || part==='.' || part==='..');
}

export function graphicsImports(base) {
  const imports = Object.fromEntries(Object.entries(direct).map(([name,relative])=>[name,base+'__uvrs_lib/'+relative]));
  for (const name of bundled) imports[name] = base+'__uvrs_bundle/'+encodeURIComponent(name);
  return imports;
}

export function approvedCDN(url,base) {
  const prefix = editableCDNs.find(value=>url.startsWith(value));
  if (!prefix) return url;
  const relative = 'three/'+url.slice(prefix.length);
  return approvedThreePath(relative) || relative==='three/examples/jsm/' ? base+'__uvrs_lib/'+relative : url;
}

export function runtimeHtml(text,base) {
  const document = parse(text,{sourceCodeLocationInfo:true});
  const changes = [];
  const imports = graphicsImports(base);
  // Import maps also apply to exact absolute module specifiers in inline JS.
  for (const prefix of editableCDNs) {
    imports[prefix+'build/three.module.js'] = imports.three;
    imports[prefix+'build/three.webgpu.js'] = imports['three/webgpu'];
    imports[prefix+'build/three.tsl.js'] = imports['three/tsl'];
    imports[prefix+'examples/jsm/'] = imports['three/addons/'];
  }
  let existing;
  let insertion = 0;
  function visit(node) {
    const location = node.sourceCodeLocation;
    if (node.nodeName === '#documentType' && location) insertion = location.endOffset;
    if (node.tagName === 'head' && location?.startTag) insertion = location.startTag.endOffset;
    if (node.tagName === 'script' && location?.startTag) {
      const attrs = Object.fromEntries(node.attrs.map(a=>[a.name,a.value]));
      if (attrs.type?.toLowerCase()==='importmap' && !existing) existing = node;
      if (attrs.src) {
        const replacement = approvedCDN(attrs.src,base);
        const attr = location.attrs?.src;
        if (replacement!==attrs.src && attr) changes.push([attr.startOffset,attr.endOffset,'src="'+replacement+'"']);
      }
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(document);
  let map = {imports};
  let end = insertion;
  if (existing && existing.sourceCodeLocation.endTag) {
    const original = JSON.parse(existing.childNodes.map(node=>node.value||'').join(''));
    const remap = entries=>Object.fromEntries(Object.entries(entries || {}).map(([id,url])=>[id,
      typeof url==='string' ? approvedCDN(url,base) : url]));
    map = {...original,imports:{...imports,...remap(original.imports)}};
    if (original.scopes) map.scopes = Object.fromEntries(Object.entries(original.scopes).map(([scope,entries])=>[approvedCDN(scope,base),remap(entries)]));
    const location = existing.sourceCodeLocation;
    changes.push([location.startOffset,location.endOffset,'']);
    // Keep the author's ordering relative to classic scripts and subsequent maps.
    insertion = location.startOffset;
    end = insertion;
  }
  changes.push([insertion,end,'<script type="importmap">'+JSON.stringify(map).replaceAll('<','\\u003c')+'</script>']);
  return changes.sort((a,b)=>b[0]-a[0] || b[1]-a[1])
    .reduce((source,[from,to,content])=>source.slice(0,from)+content+source.slice(to),text);
}

export function graphicsAsset(request,base) {
  if (request.startsWith('__uvrs_lib/')) {
    const relative = request.slice('__uvrs_lib/'.length);
    if (approvedThreePath(relative)) return {file:path.join(base,relative)};
  }
  if (request.startsWith('__uvrs_bundle/')) {
    const library = request.slice('__uvrs_bundle/'.length);
    if (bundled.includes(library)) return {library};
  }
  return null;
}
