/**
 * MediaPipe HandLandmarker 引擎封装。
 * 全部资源走本地 vendor 目录，不依赖任何 CDN。
 */

const BUNDLE_URL = new URL('../../vendor/mediapipe/vision_bundle.mjs', import.meta.url).href;
const WASM_DIR = new URL('../../vendor/mediapipe/wasm', import.meta.url).href;
const MODEL_URL = new URL('../../vendor/models/hand_landmarker.task', import.meta.url).href;

export class MediaPipeHandEngine {
  constructor(landmarker, delegate) {
    this.landmarker = landmarker;
    this.delegate = delegate;
    this.name = `mediapipe (${delegate})`;
  }

  static get modelUrl() {
    return MODEL_URL;
  }

  /**
   * @param {{numHands?:number, delegate?:'GPU'|'CPU'}} opts
   */
  static async create({ numHands = 2, delegate = 'GPU' } = {}) {
    const { FilesetResolver, HandLandmarker } = await import(BUNDLE_URL);
    const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);

    const build = (dev) =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: dev },
        runningMode: 'VIDEO',
        numHands,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

    try {
      return new MediaPipeHandEngine(await build(delegate), delegate);
    } catch (err) {
      if (delegate === 'CPU') throw err;
      console.warn('[mediapipe] GPU delegate 初始化失败，回退 CPU：', err);
      return new MediaPipeHandEngine(await build('CPU'), 'CPU');
    }
  }

  /**
   * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement} source
   * @param {number} timestampMs 必须单调递增
   */
  detect(source, timestampMs) {
    const res = this.landmarker.detectForVideo(source, timestampMs);
    const hands = [];
    const landmarksList = res?.landmarks || [];
    const worldList = res?.worldLandmarks || [];
    // 不同版本字段名不同：handedness / handednesses / handednessScores
    const handedList = res?.handednesses || res?.handedness || [];

    for (let i = 0; i < landmarksList.length; i += 1) {
      const h = handedList[i];
      const cat = Array.isArray(h) ? h[0] : h;
      hands.push({
        landmarks: landmarksList[i],
        worldLandmarks: worldList[i] || null,
        handedness: cat?.categoryName || cat?.displayName || 'Unknown',
        score: cat?.score ?? 1,
      });
    }
    return hands;
  }

  close() {
    try {
      this.landmarker?.close?.();
    } catch {
      /* 忽略 */
    }
  }
}
