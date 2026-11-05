import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
const root=createRoot(document.getElementById('root')!);
window.renderStudio={version:1,render({time,seed}:{time:number;seed:number}){
 flushSync(()=>root.render(<main style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',background:'linear-gradient(120deg,#173c59,#68bf9c)',color:'#fff',fontFamily:'sans-serif'}}><section style={{border:'2px solid #e5dcac',borderRadius:30,padding:80}}><h1 style={{fontSize:70}}>REACT / NATIVE</h1><p style={{fontSize:32}}>Frame {time} · Seed {seed}</p></section></main>));
}};
