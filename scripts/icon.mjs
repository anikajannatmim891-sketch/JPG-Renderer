import sharp from 'sharp';
import fs from 'node:fs/promises';
const svg='<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg"><rect width="256" height="256" rx="50" fill="#171e27"/><path d="M128 28L228 128 128 228 28 128Z" fill="#b6ed82"/><path d="M128 73L183 128 128 183 73 128Z" fill="#171e27"/><path d="M128 106L150 128 128 150 106 128Z" fill="#b6ed82"/></svg>';
await fs.writeFile('assets/icon.svg',svg);const png=await sharp(Buffer.from(svg)).png().toBuffer();await fs.writeFile('assets/icon.png',png);const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);await fs.writeFile('assets/icon.ico',Buffer.concat([header,png]));
