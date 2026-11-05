import sharp from 'sharp';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
export function validateSettings(s) {
  for (const key of ['width','height','designWidth','quality','seed','time']) if(!Number.isFinite(s[key])) throw new Error(`Invalid ${key}`);
  if(!Number.isInteger(s.width)||!Number.isInteger(s.height)||s.width<1||s.height<1||s.width>65535||s.height>65535) throw new Error('Dimensions must be integers from 1 to 65535');
  if(s.width*s.height>250e6) throw new Error('This release limits exports to 250 MP for memory safety');
  if(s.designWidth<1||s.designWidth>16384||s.quality<1||s.quality>100||s.time<0) throw new Error('Invalid design width, quality or time');
  if(!['jpeg','png','webp'].includes(s.format)) throw new Error('Unsupported raster format');
  if(!['direct','tiled'].includes(s.strategy)) throw new Error('Unsupported render strategy');
  if(s.transparent && s.format==='jpeg') throw new Error('JPEG cannot preserve transparency. Select PNG.');
  if(s.stock) {
    const mp=s.width*s.height/1e6;
    if(mp<4||mp>100) throw new Error('Adobe Stock mode requires 4–100 megapixels');
    if(s.format!==(s.transparent?'png':'jpeg')) throw new Error('Stock mode requires JPEG, or PNG with transparency enabled');
  }
}
export async function inspectRaster(file,s,history=[]) {
  const data=await fs.readFile(file);
  const img=sharp(data,{limitInputPixels:300e6});
  const meta=await img.metadata();
  const {data:small,info}=await img.clone().resize(64,64,{fit:'fill'}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const warnings=[];
  let minAlpha=255,maxAlpha=0,luma=[],sum=0,sum2=0;
  for(let i=0;i<small.length;i+=4){const v=(small[i]*.2126+small[i+1]*.7152+small[i+2]*.0722);luma.push(v);sum+=v;sum2+=v*v;minAlpha=Math.min(minAlpha,small[i+3]);maxAlpha=Math.max(maxAlpha,small[i+3]);}
  const mean=sum/luma.length,variance=sum2/luma.length-mean*mean;
  if(variance<2) warnings.push('Nearly uniform image: inspect for blank or missing content');
  if(mean<2) warnings.push('Nearly black frame: inspect the artwork');
  if(maxAlpha===0) warnings.push('Fully transparent frame');
  const hash=crypto.createHash('sha256').update(data).digest('hex');
  const fingerprint=Array.from({length:64},(_,n)=>luma[(Math.floor(n/8)*8)*64+(n%8)*8]>mean?'1':'0').join('');
  if(history.some(x=>x.hash===hash)) warnings.push('Exact duplicate of an earlier export');
  else if(history.some(x=>x.fingerprint?.length===64&&[...fingerprint].filter((b,i)=>b!==x.fingerprint[i]).length<5)) warnings.push('Similar perceptual fingerprint to an earlier export; review for near duplicates');
  const errors=[];
  if(meta.width!==s.width||meta.height!==s.height) errors.push('Source/export resolution mismatch');
  if(s.transparent&&(!meta.hasAlpha||minAlpha===255)) errors.push('Transparent export requested but no transparent pixels detected');
  if(!meta.icc) errors.push('Missing sRGB profile');
  if(s.stock && data.length>45_000_000) errors.push('File exceeds the 45 MB Stock limit; reduce JPEG quality explicitly');
  if(s.stock&&(meta.width*meta.height<4e6||meta.width*meta.height>100e6)) errors.push('Outside Stock megapixel limits');
  return {width:meta.width,height:meta.height,megapixels:meta.width*meta.height/1e6,bytes:data.length,format:meta.format,hasAlpha:meta.hasAlpha,alphaRange:[minAlpha,maxAlpha],srgb:!!meta.icc,hash,fingerprint,warnings,errors,variance};
}
export const defaults={width:3840,height:2160,designWidth:1920,format:'jpeg',quality:96,transparent:false,stock:false,seed:1,time:0,strategy:'direct',allowSoftware:false,allowedOrigins:[],timeout:30000};
