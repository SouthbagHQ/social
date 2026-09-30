// Browser side of D1 file storage. Photos are shrunk before upload (saves the 500 MB-per-database
// free allowance); videos get a poster frame. Files go up one chunk per request, as the Worker expects:
//   POST /api/media → PUT /api/media/:id/chunks/:i … → POST /api/media/:id/complete

import { api } from './api.js';

export const LIMITS = { image: 10 * 1048576, video: 60 * 1048576, audio: 60 * 1048576 };
const MAX_EDGE = 2048;

export const kindOf = file =>
  file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : null;

/** Shrinks big photos to ≤ 2048px WebP/JPEG. GIFs are left alone so they keep moving. */
export async function prepareImage(file, maxEdge = MAX_EDGE) {
  if (file.type === 'image/gif') return { blob: file, ...(await imageSize(file)) };
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return { blob: file, width: null, height: null };
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale), height = Math.round(bitmap.height * scale);
  if (scale === 1 && file.size < 900 * 1024 && /^image\/(jpeg|webp)$/.test(file.type)) return { blob: file, width, height };
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise(r => canvas.toBlob(r, 'image/webp', 0.85))
    || await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  return { blob: blob && blob.size < file.size ? blob : file, width, height };
}

function imageSize(file) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(img.src); };
    img.onerror = () => resolve({ width: null, height: null });
    img.src = URL.createObjectURL(file);
  });
}

/** Width, height, duration and a JPEG poster frame for a video file. */
export function videoMeta(file) {
  return new Promise(resolve => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(file);
    const finish = poster => {
      resolve({ width: video.videoWidth || null, height: video.videoHeight || null, duration: Number.isFinite(video.duration) ? video.duration : null, poster });
      URL.revokeObjectURL(url);
    };
    video.onloadedmetadata = () => { video.currentTime = Math.min(1, (video.duration || 2) / 3); };
    video.onseeked = () => {
      try {
        const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => finish(blob), 'image/jpeg', 0.8);
      } catch { finish(null); }
    };
    video.onerror = () => finish(null);
    setTimeout(() => finish(null), 15000);
    video.src = url;
  });
}

/** Uploads raw bytes; resolves to the media JSON ({ id, url, kind, width, height, poster_url, … }). */
export async function uploadBlob(blob, { kind, contentType = blob.type, width, height, duration, posterId, alt, onProgress, signal } = {}) {
  const created = await api.post('media', {
    kind, content_type: contentType, size: blob.size, width, height, duration, poster_id: posterId, alt,
  });
  const { id, chunk_size: chunkSize, chunk_count: chunkCount } = created;
  let doneBytes = 0;
  try {
    for (let i = 0; i < chunkCount; i++) {
      if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
      const part = blob.slice(i * chunkSize, Math.min(blob.size, (i + 1) * chunkSize));
      await retry(() => api.put(`media/${id}/chunks/${i}`, part));
      doneBytes += part.size;
      onProgress?.(doneBytes / blob.size);
    }
    return await api.post(`media/${id}/complete`);
  } catch (err) {
    api.del(`media/${id}`).catch(() => {});
    throw err;
  }
}

async function retry(fn, attempts = 3) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (err) {
      if (i >= attempts - 1 || (err.status && err.status < 500)) throw err;
      await new Promise(r => setTimeout(r, 800 * 2 ** i));
    }
  }
}

/**
 * Validates, prepares and uploads any file. Videos upload their poster frame first.
 * onProgress receives 0..1. Throws an Error with a user-facing message.
 */
export async function uploadFile(file, { onProgress, signal, maxEdge, alt } = {}) {
  const kind = kindOf(file);
  if (!kind) throw new Error('Only photos, videos and audio can be uploaded.');
  if (kind === 'image') {
    const { blob, width, height } = await prepareImage(file, maxEdge);
    if (blob.size > LIMITS.image) throw new Error('That photo is too big.');
    return uploadBlob(blob, { kind, width, height, alt, onProgress, signal });
  }
  if (file.size > LIMITS[kind]) {
    throw new Error(`That ${kind} is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${LIMITS[kind] / 1048576} MB.`);
  }
  let meta = {};
  let posterId;
  if (kind === 'video') {
    meta = await videoMeta(file);
    if (meta.poster) {
      const poster = await uploadBlob(meta.poster, { kind: 'image', contentType: 'image/jpeg', width: meta.width, height: meta.height, signal });
      posterId = poster.id;
    }
  }
  const contentType = file.type === 'video/x-m4v' ? 'video/mp4' : file.type;
  return uploadBlob(file, { kind, contentType, width: meta.width, height: meta.height, duration: meta.duration, posterId, alt, onProgress, signal });
}

/** Opens the file picker. accept: 'image/*', 'video/*', 'image/*,video/*'. Resolves to File[]. */
export function pickFiles({ accept = 'image/*', multiple = false } = {}) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}
