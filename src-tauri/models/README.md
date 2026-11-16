# 人臉模型

本資料夾的 ONNX 模型由 Google **MediaPipe Face Landmarker** 轉換而來，
授權為 **Apache License 2.0**（允許商業使用、修改與再散布，需保留授權聲明）。

| 檔案 | 原始模型 | 用途 |
|---|---|---|
| `face_detector.onnx` | `face_detector.tflite`（BlazeFace short-range, 128×128） | 人臉偵測 |
| `face_landmarks_detector.onnx` | `face_landmarks_detector.tflite`（478 點, 256×256） | 臉部特徵點 |
| `face_blendshapes.onnx` | `face_blendshapes.tflite`（52 個表情係數） | 閉眼分數（eyeBlinkLeft / eyeBlinkRight） |

來源：<https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task>
（`.task` 是 zip 檔，內含上述三個 `.tflite`）
模型說明：<https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker>

## 重新產生

```bash
python -m venv venv && venv/bin/pip install tensorflow tf2onnx
curl -LO https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
python -m zipfile -e face_landmarker.task fl
for m in face_detector face_landmarks_detector face_blendshapes; do
  venv/bin/python -m tf2onnx.convert --tflite fl/$m.tflite --output $m.onnx --opset 15
done
```

Copyright 2023 The MediaPipe Authors. Licensed under the Apache License, Version 2.0.
