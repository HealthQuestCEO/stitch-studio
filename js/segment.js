// "Text behind me": finds you in each frame (MediaPipe, runs in the browser)
// so text can be drawn between you and the background. Nothing is uploaded.
import { W, H } from './export.js';

let seg = null, failed = false, loading = null;
const maskCanvas = document.createElement('canvas');
const personCanvas = document.createElement('canvas');
personCanvas.width = W; personCanvas.height = H;

export async function loadSegmenter() {
  if (seg || failed) return seg;
  if (loading) return loading;
  loading = (async () => {
    try {
      const v = '0.10.14';
      const { FilesetResolver, ImageSegmenter } = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${v}/vision_bundle.mjs`);
      const files = await FilesetResolver.forVisionTasks(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${v}/wasm`);
      seg = await ImageSegmenter.createFromOptions(files, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
    } catch (e) {
      console.warn('segmenter', e);
      failed = true;
    }
    return seg;
  })();
  return loading;
}
export const segmenterFailed = () => failed;

let lastTs = 0;
// Draw just the person from `video` (cover-cropped) on top of whatever is on ctx.
export function drawPerson(ctx, video) {
  if (!seg || !video.videoWidth) return false;
  const vw = video.videoWidth, vh = video.videoHeight;
  let res;
  const ts = Math.max(performance.now(), lastTs + 1); lastTs = ts;
  try { res = seg.segmentForVideo(video, ts); } catch { return false; }
  const m = res && res.confidenceMasks && res.confidenceMasks[0];
  if (!m) return false;
  const mw = m.width, mh = m.height, data = m.getAsFloat32Array();
  maskCanvas.width = mw; maskCanvas.height = mh;
  const mctx = maskCanvas.getContext('2d');
  const img = mctx.createImageData(mw, mh);
  for (let i = 0; i < data.length; i++) {
    const a = Math.max(0, Math.min(1, (data[i] - 0.35) / 0.3)); // soft edge
    img.data[i * 4 + 3] = a * 255;
  }
  mctx.putImageData(img, 0, 0);
  res.close && res.close();

  const scale = Math.max(W / vw, H / vh);
  const dw = vw * scale, dh = vh * scale, dx = (W - dw) / 2, dy = (H - dh) / 2;
  const p = personCanvas.getContext('2d');
  p.globalCompositeOperation = 'source-over';
  p.clearRect(0, 0, W, H);
  p.drawImage(video, dx, dy, dw, dh);
  p.globalCompositeOperation = 'destination-in';
  p.drawImage(maskCanvas, dx, dy, dw, dh);
  p.globalCompositeOperation = 'source-over';
  ctx.drawImage(personCanvas, 0, 0);
  return true;
}
