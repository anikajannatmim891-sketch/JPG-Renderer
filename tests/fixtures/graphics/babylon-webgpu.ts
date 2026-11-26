import {WebGPUEngine, Scene, ArcRotateCamera, Vector3, Color4, Color3, MeshBuilder, PBRMaterial,
  HemisphericLight, DirectionalLight} from '@babylonjs/core';

const canvas=document.createElement('canvas');
document.body.append(canvas);
canvas.style.cssText='width:960px;height:540px;display:block';
let engine,scene;
window.renderStudio={
  version:2,engine:'Babylon.js WebGPU',design:{width:960,height:540},
  async ready(){
    engine=new WebGPUEngine(canvas,{antialias:true,powerPreference:'high-performance',setMaximumLimits:true});
    await engine.initAsync();
    scene=new Scene(engine);
    scene.clearColor=new Color4(.12,.19,.34,1);
    const camera=new ArcRotateCamera('camera',-1.0,1.06,7,new Vector3(0,.35,0),scene);
    camera.minZ=.1;
    const key=new DirectionalLight('key',new Vector3(-1,-1,1),scene);key.intensity=3;
    const fill=new HemisphericLight('fill',Vector3.Up(),scene);fill.intensity=.7;
    const sculpture=MeshBuilder.CreateTorusKnot('knot',{radialSegments:72,tubularSegments:16},scene);
    const material=new PBRMaterial('ceramic',scene);
    material.albedoColor=new Color3(.88,.35,.15);
    material.roughness=.27;
    material.metallic=.18;
    sculpture.material=material;
  },
  async render({width,height}){
    engine.setSize(width,height,true);
    await scene.whenReadyAsync();
    engine.beginFrame();
    scene.render();
    engine.endFrame();
  },
  dispose(){scene?.dispose();engine?.dispose();},
};
