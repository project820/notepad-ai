# Bundled Tesseract language data (offline OCR)

`ocr.ts` runs Tesseract with an explicit local `langPath` so the packaged app
never fetches language data from a CDN (decision A2 / AC15). Place the compressed
traineddata files here before packaging — `electron-builder` copies this folder
to `<app>/Contents/Resources/tesseract/lang-data` via `build.extraResources`.

Required files (Tesseract best/`*.traineddata.gz`):

- `kor.traineddata.gz`
- `eng.traineddata.gz`

Vendoring (run once / in CI before `npm run build:dmg`):

```sh
mkdir -p resources/tessdata
curl -L -o resources/tessdata/eng.traineddata.gz \
  https://github.com/naptha/tessdata/raw/gh-pages/4.0.0_best/eng.traineddata.gz
curl -L -o resources/tessdata/kor.traineddata.gz \
  https://github.com/naptha/tessdata/raw/gh-pages/4.0.0_best/kor.traineddata.gz
```

These binaries are intentionally NOT committed (large). A dev run resolves the
same files from this folder; if absent, OCR surfaces an actionable error rather
than silently fetching from the network.
