import * as THREE from 'three';
import { surfaceNormalMap, surfaceTexture } from '@client/render/textures.js';
import { SurfaceType } from '@shared/types.js';

const status = document.querySelector<HTMLElement>('#status');

async function canvasBlob(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}

async function textureBlob(texture: THREE.Texture): Promise<Blob> {
  const image = texture.image as
    | HTMLCanvasElement
    | OffscreenCanvas
    | { data: Uint8Array; width: number; height: number };
  if (image instanceof HTMLCanvasElement || image instanceof OffscreenCanvas) return canvasBlob(image);

  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas unavailable');
  const pixels = new Uint8ClampedArray(image.data.length);
  pixels.set(image.data);
  context.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

async function send(name: string, texture: THREE.Texture): Promise<void> {
  const response = await fetch(`/__texture-export/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: await textureBlob(texture),
  });
  if (!response.ok) throw new Error(`Failed to export ${name}: ${response.status}`);
}

async function exportTextures(): Promise<void> {
  let count = 0;
  for (let surface = SurfaceType.Concrete; surface <= SurfaceType.Brick; surface++) {
    const name = SurfaceType[surface]!.toLowerCase();
    await send(`${name}-albedo.png`, surfaceTexture(surface));
    await send(`${name}-normal.png`, surfaceNormalMap(surface));
    count += 2;
    if (status) status.textContent = `Exported ${count}/32 canonical textures…`;
  }

  const response = await fetch('/__texture-export-complete', { method: 'POST' });
  if (!response.ok) throw new Error(`Failed to finish export: ${response.status}`);
  if (status) status.textContent = `DONE: ${count} canonical textures exported`;
}

void exportTextures().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  if (status) status.textContent = `ERROR: ${message}`;
  console.error(error);
});
