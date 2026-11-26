let canvas,ctx;
self.onmessage=({data})=>{
  if(data.surface){canvas=data.surface;ctx=canvas.getContext('2d');return;}
  canvas.width=data.width;canvas.height=data.height;
  const g=ctx.createLinearGradient(0,0,data.width,data.height);
  g.addColorStop(0,'#0e264f');g.addColorStop(.52,'#b5a372');g.addColorStop(1,'#832025');
  ctx.fillStyle=g;ctx.fillRect(0,0,data.width,data.height);
  ctx.fillStyle='#f1eee2';ctx.beginPath();ctx.ellipse(data.width*.47,data.height*.57,data.width*.19,data.height*.24,.3,0,Math.PI*2);ctx.fill();
  self.postMessage('done');
};
