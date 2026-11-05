import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mime = {'.html':'text/html','.svg':'image/svg+xml','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.glsl':'text/plain','.hdr':'application/octet-stream','.gltf':'model/gltf+json','.glb':'model/gltf-binary'};
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
export async function serveProject(project) {
  const token = crypto.randomBytes(24).toString('hex');
  let bundle;
  if (['js','mjs','ts','jsx','tsx'].includes(project.kind)) {
    const dependencies=path.resolve(path.dirname(require.resolve('three')), '../..');
    const result = await build({plugins:[{name:'project-boundary',setup(builder){builder.onLoad({filter:/.*/},async args=>{const real=await fs.realpath(args.path);if(!real.startsWith(project.root+path.sep)&&!real.startsWith(dependencies+path.sep))throw new Error('Bundled import escapes selected project: '+path.basename(real));return undefined;});}}],entryPoints:[project.file],bundle:true,write:false,platform:'browser',format:'esm',jsx:'automatic',nodePaths:[path.resolve(path.dirname(require.resolve('three')), '../..')],logLevel:'silent',loader:{'.glsl':'text','.vert':'text','.frag':'text'}});
    bundle=result.outputFiles[0].contents;
  }
  const server = http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    try {
      const url = new URL(req.url,'http://localhost');
      if (!url.pathname.startsWith('/'+token+'/') || !['GET','HEAD'].includes(req.method)) {res.writeHead(403).end();return;}
      const rel = decodeURIComponent(url.pathname.slice(token.length+2));
      if (bundle && rel==='__studio_entry.html') {res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root"></div><script type="module" src="__studio_bundle.js"></script></body></html>');return;}
      if (bundle && rel==='__studio_bundle.js') {res.setHeader('Content-Type','text/javascript');res.end(bundle);return;}
      const file = await contained(project.root,rel);
      const stat = await fs.stat(file);
      if(!stat.isFile()) throw new Error('Not a file');
      res.setHeader('Content-Type',(mime[path.extname(file).toLowerCase()]||'application/octet-stream')+'; charset=utf-8');
      res.end(await fs.readFile(file));
    } catch {res.writeHead(404).end('Asset unavailable');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base = `http://127.0.0.1:${server.address().port}/${token}/`;
  return {url:base+(bundle?'__studio_entry.html':project.entry.split(path.sep).map(encodeURIComponent).join('/')),origin:new URL(base).origin,base,close:()=>new Promise(r=>server.close(r))};
}
