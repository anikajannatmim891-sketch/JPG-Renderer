struct Params { size:vec2f, origin:vec2f }
@group(0) @binding(0) var<uniform> params:Params;
@vertex fn vertex(@builtin(vertex_index) i:u32) -> @builtin(position) vec4f {
  let points=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return vec4f(points[i],0,1);
}
@fragment fn fragment(@builtin(position) p:vec4f) -> @location(0) vec4f {
  let uv=(p.xy+params.origin)/params.size;
  let wave=sin((uv.x*8.5+uv.y*6.2)*6.283185)*cos(uv.y*16.0);
  return vec4f(0.10+uv.x*.75,0.12+uv.y*.72,.45+wave*.30,1.0);
}
