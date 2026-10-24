# EmCorder

EmCorder is a Windows 11 webcam recorder. Set up a camera and script, record, and save an MP4 from one window.

Features: 720p and 1080p recording, background blur, brightness, contrast, and saturation adjustments, a draggable teleprompter, and local storage for scripts and settings. The teleprompter sits above the preview and is never recorded. Video, audio, and scripts stay on your machine. There are no accounts, analytics, or cloud services.

## Run and build

Use Node.js 22.12 or newer and npm on Windows 11. Clone the repository and run:

```powershell
npm ci
npm run dev
```

```powershell
npm run typecheck    # Check TypeScript
npm test             # Run unit and QA tests
npm run test:desktop # Build and test version display and single-instance behavior
npm run build        # Typecheck and compile the app
npm run preview      # Run the compiled app
npm run test:studio  # Build and test the studio with a synthetic camera
npm run test:spike   # Build and run synthetic 1-minute and 5-minute recordings
npm run package      # Build a runnable Windows folder in release/win-unpacked
npm run dist         # Build the Windows x64 installer in release/
```

To install a local build, run `npm run dist`, then open `release/EmCorder-Setup-<version>-x64.exe`. The wizard installs for the current Windows user, creates desktop and Start menu shortcuts, and offers to launch EmCorder on Finish. It also appears in Windows Settings under installed apps. The app is unsigned, so Windows may show a security warning.

To update, save your take, close EmCorder, and run the newer installer. Preferences, scripts, and temporary takes remain in `%APPDATA%/emcorder`; uninstall also retains that data. Saved videos stay in their chosen folders. There are no automatic update checks. This repository currently provides source and local build instructions, with no hosted installer downloads.

For a runnable folder instead, use `npm run package`, open `EmCorder.exe` in `release/win-unpacked`, and keep the folder intact. See [releasing and versioning](docs/RELEASING.md) for the release workflow.

## Using the studio

1. Click **Connect camera**, then choose a camera, microphone, and quality. Quality defaults to 720p and is remembered. Changing any of them reconnects the preview. If the camera rejects 1080p, the app retries 720p on the same camera.
2. Toggle background blur, expand **Image** to adjust brightness, contrast, and saturation from 50–150%, and check the microphone meter. Image adjustments apply to the preview and saved video, work with blur on or off, and are remembered. **Reset** returns only image adjustments to neutral. During recording, a warning appears after sustained silence.
3. Write or paste a script, show the teleprompter, and place it near the webcam. Adjust font size, speed, and opacity.
4. Click **Record** or press `Ctrl+Shift+R`. A cancellable countdown runs first, and the teleprompter can start scrolling when recording begins. **Retake** discards the take and restarts the countdown.
5. Stop to review the MP4, then **Save** (choose a filename and folder) or **Retake**.

The header gear opens **Settings**: countdown (3–10 seconds), mirroring, automatic prompter scrolling, default save folder, and keyboard shortcuts. Changes persist across launches. Mirroring applies to the preview, review, and saved MP4. Capture settings lock during a take and during review.

Settings also shows the app version. Launching EmCorder again brings the existing window forward.

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
- [Releasing and versioning](docs/RELEASING.md)
- [Branding assets](src/renderer/public/branding/README.md)
