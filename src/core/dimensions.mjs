export const presets = {'4K':4096,'6K':6144,'8K':8192,'10K':10240,'12K':12288};
export const profiles = {
  adobe:{label:'Adobe Stock', minPixels:4e6, maxPixels:100e6, maxBytes:45e6, maxEdge:65535, keywords:49},
  shutterstock:{label:'Shutterstock', minPixels:4e6, maxPixels:100e6, maxBytes:50e6, maxEdge:65535, keywords:50},
};

export const gcd = (a, b) => b ? gcd(b, a % b) : a;
export const sameAspect = (w, h, x, y) => w * y === h * x;
export const close = (a, b, tolerance = 0.05) => Math.abs(a - b) <= tolerance;
const valid = (width, height) => [width, height].every(n => Number.isInteger(n) && n > 0 && n <= 16384);

export function viewportFor(settings) {
  const {width, height, designWidth:cssWidth} = settings;
  const cssHeight = settings.designHeight ?? Math.round(height * cssWidth / width);
  if (!valid(cssWidth, cssHeight) || !sameAspect(cssWidth, cssHeight, width, height))
    throw new Error('Output and integer CSS viewport must have the same aspect ratio');
  return {cssWidth, cssHeight, ratio:width / cssWidth};
}

export function planDimensions(cssWidth, cssHeight, {preset='10K', customEdge=10240, profile='adobe', limitEdge=Infinity} = {}) {
  if (!valid(cssWidth, cssHeight)) throw new Error('Artwork needs a verified integer CSS width and height');
  const limits = profiles[profile];
  if (!limits) throw new Error('Unknown stock profile');
  const edge = preset === 'max' ? limits.maxEdge : preset === 'custom' ? customEdge : presets[preset];
  if (!Number.isSafeInteger(edge) || edge < 1 || edge > 65535) throw new Error('Invalid longest-edge preference');
  const divisor = gcd(cssWidth, cssHeight);
  const w = cssWidth / divisor;
  const h = cssHeight / divisor;
  const longest = Math.max(w, h);
  const min = Math.ceil(Math.sqrt(limits.minPixels / (w * h)));
  const max = Math.min(Math.floor(Math.sqrt(limits.maxPixels / (w * h))),
    Math.floor(Math.min(limits.maxEdge, limitEdge) / longest));
  if (min > max) throw new Error('No exact-aspect dimensions fit the selected stock limits');
  // Treat the requested edge as a target. Round to the nearest exact-aspect
  // output while respecting the selected platform and any verified backend cap.
  const multiple = Math.min(max, Math.max(min, Math.round(edge / longest)));
  return {width:w * multiple, height:h * multiple, designWidth:cssWidth, designHeight:cssHeight};
}

export function filenameHints(filename) {
  const css = filename.match(/(?:^|[_-])css(\d+)x(\d+)(?=[_.-]|$)/i);
  const output = filename.match(/(?:^|[_-])\d+k[-_]?(\d+)x(\d+)(?=[_.-]|$)/i);
  const width = Number(filename.match(/(?:^|[_-])w(\d+)(?=[_.-]|$)/i)?.[1]);
  const cssWidth = Number(css?.[1]) || width;
  const cssHeight = Number(css?.[2]) || (output ? cssWidth * Number(output[2]) / Number(output[1]) : 0);
  return valid(cssWidth, cssHeight) ? {width:cssWidth,height:cssHeight,source:'filename hint'} : null;
}
