import {Engine, Scene, Color3, Color4, Vector3, ArcRotateCamera, MeshBuilder, PBRMaterial,
  Matrix,HemisphericLight, DirectionalLight, ShadowGenerator, DefaultRenderingPipeline} from '@babylonjs/core';

const canvas = document.createElement('canvas');
document.body.append(canvas);
canvas.style.cssText = 'width:960px;height:540px;display:block';
const engine = new Engine(canvas,true,{preserveDrawingBuffer:true,stencil:true},false);
engine.setHardwareScalingLevel(1);
const scene = new Scene(engine);
scene.clearColor = new Color4(.12,.18,.26,1);
const camera = new ArcRotateCamera('camera',-1.04,1.22,12,new Vector3(0,1.3,0),scene);
camera.minZ=.05;
const fill = new HemisphericLight('soft studio fill',new Vector3(-.4,1,1),scene);
fill.intensity=.85;
const key = new DirectionalLight('key',new Vector3(-.6,-.9,1),scene);
key.position.set(4,7,-6);
key.intensity=2.4;
const shadows = new ShadowGenerator(1024,key);
shadows.usePercentageCloserFiltering=true;
const material = (name,color,metallic,roughness) => {
  const result = new PBRMaterial(name,scene);
  result.albedoColor=Color3.FromHexString(color);
  result.metallic=metallic;
  result.roughness=roughness;
  return result;
};
const stone=material('architectural stone','#365365',.16,.36);
const gold=material('brushed gold','#cc992d',.67,.24);
gold.clearCoat.isEnabled=true;
const glass=material('tinted glass','#4ca7c4',.05,.18);
glass.alpha=.56;
glass.indexOfRefraction=1.46;
const ground=MeshBuilder.CreateGround('floor',{width:24,height:24},scene);
ground.material=stone;
ground.receiveShadows=true;
const feature=MeshBuilder.CreateTorusKnot('metal optical sculpture',{radius:.75,tube:.22,radialSegments:96,tubularSegments:32},scene);
feature.position.set(-1.3,1.7,0);
feature.material=gold;
shadows.addShadowCaster(feature);
const orb=MeshBuilder.CreateSphere('glass sphere',{diameter:1.3,segments:40},scene);
orb.position.set(1.3,1.45,-.45);
orb.material=glass;
for(let i=0;i<16;i++){
  const column=MeshBuilder.CreateCylinder('colonnade',{height:3.1+i%3*.3,diameter:.22,tessellation:20},scene);
  column.position.set(-4+i*.54,1.65,2.7+((i%2)*.18));
  column.material=i%3?stone:gold;
}
const pipeline=new DefaultRenderingPipeline('authored postprocess',true,scene,[camera]);
pipeline.fxaaEnabled=true;
window.renderStudio={
  version:2,engine:'Babylon.js / WebGL2',design:{width:960,height:540},
  capabilities:{tiles:true,tilePadding:6,tileSize:480},
  beginTile({tile}){
    const projection=Matrix.PerspectiveFovLH(camera.fov,tile.fullWidth/tile.fullHeight,camera.minZ,camera.maxZ);
    const clip=Matrix.FromValues(tile.fullWidth/tile.width,0,0,0,0,tile.fullHeight/tile.height,0,0,0,0,1,0,
      (tile.fullWidth-2*tile.x-tile.width)/tile.width,(2*tile.y+tile.height-tile.fullHeight)/tile.height,0,1);
    camera.freezeProjectionMatrix(projection.multiply(clip));
  },
  endTile(){camera.unfreezeProjectionMatrix();},
  async render({width,height,tile}){
    engine.setSize(tile?.width ?? width,tile?.height ?? height,true);
    canvas.style.width=(tile?tile.width/(width/960):960)+'px';
    canvas.style.height=(tile?tile.height/(height/540):540)+'px';
    await scene.whenReadyAsync();
    scene.render();
  },
  dispose(){pipeline.dispose();scene.dispose();engine.dispose();},
};
