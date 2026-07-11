# Bundled Tesseract language data (offline OCR)

`src/main/ai/ocr.ts` passes this directory as Tesseract's explicit local
`langPath`, so the packaged app never fetches language data from a CDN.
`electron-builder` copies it to
`<app>/Contents/Resources/tesseract/lang-data` via `build.extraResources`.

Required compressed files:

- `eng.traineddata.gz`
- `kor.traineddata.gz`

These archives are committed so a fresh clone can package offline OCR. Keep them
compressed: `npm run preflight:tessdata` verifies both files exist, exceed 100
KiB, and have gzip magic bytes. `npm run build:dmg` and `npm run install:local`
run this check automatically; CI runs it before the build.

When the preflight fails, restore the committed files with:

```sh
git restore resources/tessdata
```

For a clone or archive missing them, download the compressed Tesseract best
language data into this directory (do not decompress):

```sh
curl -L -o resources/tessdata/eng.traineddata.gz \
  https://github.com/naptha/tessdata/raw/gh-pages/4.0.0_best/eng.traineddata.gz
curl -L -o resources/tessdata/kor.traineddata.gz \
  https://github.com/naptha/tessdata/raw/gh-pages/4.0.0_best/kor.traineddata.gz
```
