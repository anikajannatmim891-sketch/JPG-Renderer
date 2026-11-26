import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {bundleGraphics,graphicsAsset,inside,privatePath,runtimeHtml} from './graphics-dependencies.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mime = {'.html':'text/html','.htm':'text/html','.svg':'image/svg+xml','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.glsl':'text/plain','.wgsl':'text/plain','.vert':'text/plain','.frag':'text/plain','.obj':'text/plain','.mtl':'text/plain','.wasm':'application/wasm','.ktx2':'image/ktx2','.dds':'application/octet-stream','.webm':'video/webm','.mp4':'video/mp4','.hdr':'application/octet-stream','.avif':'image/avif','.gif':'image/gif','.otf':'font/otf','.bmp':'image/bmp','.bin':'application/octet-stream','.gltf':'model/gltf+json','.glb':'model/gltf-binary'};
export async function contained(root, relative) {
  const base = await fs.realpath(root);
  const file = await fs.realpath(path.resolve(base, relative));
  if (file !== base && !file.startsWith(base + path.sep)) throw new Error('Asset escapes selected project folder');
  return file;
}
export async function inspectProject(selected) {
  const stat = await fs.stat(selected);
  const root = await fs.realpath(stat.isDirectory() ? selected : path.dirname(selected));
  let manifest = {};
  try { manifest = JSON.parse(await fs.readFile(path.join(root,'render-studio.json'),'utf8')); }
  catch(e) { if(e.code !== 'ENOENT') throw new Error(`Invalid project manifest: ${e.message}`); }
  let entry = stat.isDirectory() ? manifest.entry || 'index.html' : path.basename(selected);
  if (typeof entry !== 'string') throw new Error('Manifest entry must be a filename');
  const file = await contained(root,entry);
  const ext = path.extname(file).toLowerCase();
  if (!['.html','.htm','.svg','.js','.mjs','.ts','.jsx','.tsx'].includes(ext)) throw new Error('Choose HTML, SVG, JS, TS, JSX or TSX');
  if (manifest.buildCommand) throw new Error('External build commands are not executed automatically. Build this trusted project separately and open its browser output.');
  for (const asset of manifest.requiredAssets || []) await contained(root,asset);
  return {root,entry:path.relative(root,file),file,kind:ext.slice(1),manifest,name:path.basename(root)};
}
export async function serveProject(project, {offline=false}={}) {
  const token = crypto.randomBytes(24).toString('hex');
  const packages = await fs.realpath(process.env.UVRS_BROWSER_DEPENDENCIES || path.resolve(path.dirname(require.resolve('three')),'../..'));
  const bundled = new Map();
  const bundle = ['js','mjs','ts','jsx','tsx'].includes(project.kind)
    ? await bundleGraphics({entry:project.file,root:project.root,packages}) : null;
  const server = http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    if (offline) res.setHeader('X-DNS-Prefetch-Control','off');
    if (offline) res.setHeader('Content-Security-Policy', [
      "default-src 'self' data: blob:", "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
      "style-src 'self' 'unsafe-inline'", "connect-src 'self'", "object-src 'none'",
      "frame-src 'none'", "base-uri 'none'", "form-action 'none'",
    ].join('; '));
    try {
      const url = new URL(req.url,'http://localhost');
      if (!url.pathname.startsWith('/'+token+'/') || !['GET','HEAD'].includes(req.method)) {res.writeHead(403).end();return;}
      const rel = decodeURIComponent(url.pathname.slice(token.length+2));
      if (rel==='__uvrs_probe') {res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>GPU probe</title>');return;}
      if (bundle && rel==='__studio_entry.html') {res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root"></div><script type="module" src="__studio_bundle.js"></script></body></html>');return;}
      if (bundle && rel==='__studio_bundle.js') {res.setHeader('Content-Type','text/javascript');res.end(bundle);return;}
      const graphics = graphicsAsset(rel,packages);
      if (graphics?.library) {
        const library = graphics.library;
        if (!bundled.has(library)) bundled.set(library,bundleGraphics({library,root:project.root,packages}));
        res.setHeader('Content-Type','text/javascript');
        res.end(await bundled.get(library));return;
      }
      const file = graphics?.file ? await fs.realpath(graphics.file) : await contained(project.root,rel);
      const relative = path.relative(graphics?.file ? packages : project.root,file);
      const ext = path.extname(file).toLowerCase();
      if (!inside(graphics?.file ? packages : project.root,file) || privatePath(relative) || !Object.hasOwn(mime,ext))
        throw new Error('File is not a supported project asset');
      const stat = await fs.stat(file);
      if(!stat.isFile() || stat.size>150_000_000) throw new Error('Not a file');
      res.setHeader('Content-Type',(mime[path.extname(file).toLowerCase()]||'application/octet-stream')+'; charset=utf-8');
      const data = await fs.readFile(file);
      res.end(['.html','.htm'].includes(ext) ? runtimeHtml(data.toString('utf8'),base) : data);
    } catch {res.writeHead(404).end('Asset unavailable');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base = `http://127.0.0.1:${server.address().port}/${token}/`;
  return {url:base+(bundle?'__studio_entry.html':project.entry.split(path.sep).map(encodeURIComponent).join('/')),origin:new URL(base).origin,base,close:()=>new Promise(r=>server.close(r))};
}
