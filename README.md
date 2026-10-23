# EmCorder

EmCorder is a Windows 11 webcam recorder. Set up a camera and script, record, and save an MP4 from one window.

Features: 720p and 1080p recording, background blur, a draggable teleprompter, and local storage for scripts and settings. The teleprompter sits above the preview and is never recorded. Video, audio, and scripts stay on your machine. There are no accounts, analytics, or cloud services.

## Run and build

Use Node.js 22.12 or newer and npm on Windows 11. Clone the repository and run:

```powershell
npm ci
npm run dev
```

```powershell
npm run typecheck    # Check TypeScript
npm test             # Run unit and QA tests
npm run build        # Typecheck and compile the app
npm run preview      # Run the compiled app
npm run test:studio  # Build and test the studio with a synthetic camera
npm run test:spike   # Build and run synthetic 1-minute and 5-minute recordings
npm run package      # Build a runnable Windows folder in release/win-unpacked
```

To run the packaged app, open `EmCorder.exe` in `release/win-unpacked` and keep the folder intact. The app is unsigned, so Windows may show a security warning. This repository provides source only. There are no downloadable releases.

## Using the studio

1. Click **Connect camera**, then choose a camera, microphone, and quality. Quality defaults to 720p and is remembered. Changing any of them reconnects the preview. If the camera rejects 1080p, the app retries 720p on the same camera.
2. Toggle background blur and check the microphone meter. During recording, a warning appears after sustained silence.
3. Write or paste a script, show the teleprompter, and place it near the webcam. Adjust font size, speed, and opacity.
4. Click **Record** or press `Ctrl+Shift+R`. A cancellable countdown runs first, and the teleprompter can start scrolling when recording begins. **Retake** discards the take and restarts the countdown.
5. Stop to review the MP4, then **Save** (choose a filename and folder) or **Retake**.

The header gear opens **Settings**: countdown (3–10 seconds), mirroring, automatic prompter scrolling, default save folder, and keyboard shortcuts. Changes persist across launches. Mirroring applies to the preview, review, and saved MP4. Capture settings lock during a take and during review.

`Space` plays or pauses teleprompter scrolling, or playback during review. `R` restarts the script. Shortcuts work only inside the app and are ignored while typing or in a dialog.

## Limits

- Windows 11 is the supported platform. Other operating systems are not supported.
- Recording requires a camera and microphone at 30 FPS. Available quality depends on the camera.
- Recordings warn at 14 minutes and stop at 15 minutes. There is no pause, video editing, or transcription.
- Export is direct H.264/AAC MP4 recording. If the bundled runtime cannot record that format, recording is unavailable.
- Blur quality depends on lighting, motion, and hardware. If segmentation fails, recording continues without blur.

## Local data and privacy

The segmentation models and WASM runtime are bundled, and the app blocks external network requests while running. Installing dependencies and building need network access unless packages are cached.

Preferences, including your script, are stored in `%APPDATA%/emcorder/preferences.json`. Takes stream to `%APPDATA%/emcorder/takes/` and are copied to your chosen folder on save, never overwriting existing files. A failed save keeps the temporary take for another attempt.

Temporary takes left after closing or a crash are not restored into the studio, and an interrupted recording may be incomplete or unplayable. Save takes before closing the app.

## Maintenance

Bug reports and contributions are welcome through GitHub issues and pull requests. For recording or device problems, include your Windows version, camera and microphone models, selected quality, and reproduction steps. Do not attach private recordings or scripts.

## License and documentation

The code is licensed under the [MIT license](LICENSE). Bundled third-party assets retain their own licenses; see the [third-party notices](docs/third-party-notices.md).

- [Changelog](CHANGELOG.md)
- [Branding assets](src/renderer/public/branding/README.md)
