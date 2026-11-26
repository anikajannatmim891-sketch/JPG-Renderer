import * as THREE from 'three';
import {WebGLPathTracer, PhysicalCamera, ShapedAreaLight} from 'three-gpu-pathtracer';
const scene=new THREE.Scene();
scene.background=new THREE.Color('#435d78');
const camera=new PhysicalCamera(41,16/9,.05,50);
camera.position.set(3.4,2.25,5.8);
camera.lookAt(0,1.0,0);
camera.fStop=5.6;
const renderer=new THREE.WebGLRenderer({preserveDrawingBuffer:true});
renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure=1.15;
document.body.append(renderer.domElement);
renderer.domElement.style.cssText='display:block;width:960px;height:540px';
const mesh=(geometry,material,x,y,z)=>{
  const item=new THREE.Mesh(geometry,material);
  item.position.set(x,y,z);
  scene.add(item);
  return item;
};
mesh(new THREE.PlaneGeometry(30,30),new THREE.MeshStandardMaterial({color:'#487c8d',roughness:.38}),0,0,0).rotation.x=-Math.PI/2;
mesh(new THREE.SphereGeometry(.71,42,22),new THREE.MeshPhysicalMaterial({color:'#dfa539',metalness:1,roughness:.22,clearcoat:.6}),-.87,.77,0);
mesh(new THREE.SphereGeometry(.72,42,22),new THREE.MeshPhysicalMaterial({color:'#91d4f3',transmission:1,roughness:.07,ior:1.49,thickness:1.2}),.88,.78,-.14);
for(let i=0;i<8;i++)mesh(new THREE.BoxGeometry(.34,2.8,.4),new THREE.MeshStandardMaterial({color:i%2?'#506886':'#8196a9',roughness:.57}),-3+i*.84,1.4,-2);
const key=new ShapedAreaLight(0xffeed7,18,3.2,2.4);
key.position.set(0,4,1.5);
key.lookAt(0,0,0);
scene.add(key);
const fill=new ShapedAreaLight(0xbddbff,7,3,3);
fill.position.set(-3,2,.5);
fill.lookAt(0,.4,0);
scene.add(fill);
const tracer=new WebGLPathTracer(renderer);
tracer.renderScale=1;
tracer.dynamicLowRes=false;
tracer.rasterizeScene=false;
tracer.fadeDuration=0;
tracer.minSamples=1;
tracer.renderDelay=0;
tracer.bounces=5;
window.renderStudio={
  version:2,engine:'Three.js WebGL2 path tracing',design:{width:960,height:540},
  progressive:{minSamples:3,maxSamples:4,requireConvergence:true},
  render({width,height}){
    renderer.setSize(width,height,false);
    tracer.setScene(scene,camera);
    tracer.reset();
  },
  async sample({samples:previous}){
    do {
      tracer.renderSample();
      await new Promise(resolve=>requestAnimationFrame(resolve));
    } while (Math.floor(tracer.samples)<=previous);
    const samples=Math.floor(tracer.samples);
    return {samples,converged:samples>=3};
  },
  dispose(){tracer.dispose();renderer.dispose();},
};
