# Third-party media assets

## MediaPipe

The app bundles `@mediapipe/tasks-vision` 1.1.1 and its matching WASM runtime from the npm package. The files under `src/renderer/public/mediapipe/` are copied from that package's `wasm/` directory. Upgrade them together with the JavaScript package. MediaPipe is licensed under Apache License 2.0; the full license is included alongside the runtime as `LICENSE`.

## Selfie segmentation models

### Primary model (`selfie_multiclass_256x256.tflite`)

- Model: Google MediaPipe SelfieMulticlass, float32, 256 × 256 input, 6 classes (`background`, `hair`, `body-skin`, `face-skin`, `clothes`, `others`).
- Local file: `src/renderer/public/models/selfie_multiclass_256x256.tflite`.
- Downloaded October 23, 2026 from [Google's official model storage](https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite).
- SHA-256: `c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0`.
- License: Apache License 2.0, stated in [Google's multiclass segmentation model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Multiclass%20Segmentation.pdf).

### Fallback model (`selfie_segmenter.tflite`)

- Model: Google MediaPipe SelfieSegmenter landscape, float16, 256 × 144 input.
- Local file: `src/renderer/public/models/selfie_segmenter.tflite`.
- Downloaded October 23, 2026 from [Google's official model storage](https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite).
- SHA-256: `490e9ea734313e0de10fa0cd9e3c6133e36ea4db2b7a49bde9ef019f72796b8e`.
- License: Apache License 2.0, stated on page 1 of [Google's model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf).

Electron includes its own Chromium media components and notices.
