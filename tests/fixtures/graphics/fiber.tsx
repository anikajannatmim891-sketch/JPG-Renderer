import React from 'react';
import * as THREE from 'three';
import {createRoot,flushSync,extend} from '@react-three/fiber';
extend(THREE);
const canvas=document.createElement('canvas');
canvas.style.cssText='width:960px;height:540px;display:block';
document.body.append(canvas);
const root=createRoot(canvas);
let state;
window.renderStudio={
  version:2,engine:'React Three Fiber / WebGL2',design:{width:960,height:540},
  async render({pixelRatio}){
    await root.configure({frameloop:'never',dpr:pixelRatio,size:{width:960,height:540,top:0,left:0},
      camera:{position:[3.2,2.4,5.6],fov:37},onCreated:value=>{state=value;}});
    flushSync(()=>root.render(<>
      <color attach="background" args={['#1c334c']}/>
      <ambientLight intensity={1.2}/><directionalLight position={[3,5,1]} intensity={3}/>
      <mesh><torusKnotGeometry args={[.9,.25,128,24]}/><meshPhysicalMaterial color="#dca74b" metalness={.5} roughness={.27} clearcoat={.7}/></mesh>
    </>));
    for(let i=0;!state && i<15;i++)await new Promise(resolve=>requestAnimationFrame(resolve));
    if(!state)throw new Error('React Three Fiber did not finish mounting');
    state.advance(0,true);
  },
  dispose(){root.unmount();},
};
