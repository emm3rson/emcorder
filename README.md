# EmCorder

EmCorder is a Windows 11 camera recorder for short webcam videos, mainly job-application introductions. Prepare a script and camera, record, and save an MP4 from one window.

The studio includes 720p and 1080p recording, background blur, a draggable teleprompter, and local script and settings storage. The teleprompter stays above the preview and never appears in the recording. Video, audio, and scripts stay on your machine. There are no accounts, analytics, or cloud services.

## Run and build

Use Node.js 22.12 or newer and npm on Windows 11. Clone this repository, open its folder, and run:

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

To run the packaged app, open `EmCorder.exe` inside `release/win-unpacked`. Keep the whole folder together. The app is unsigned, so Windows may show a security warning. This repository currently provides source code; downloadable releases are not included.

## Using the studio

1. Click **Connect camera** and choose your camera, microphone, and quality. Quality starts at 720p and remembers your selection. Changing a device or quality reconnects the preview. If the selected camera rejects 1080p, the app tries 720p on that same camera.
2. Toggle background blur and check the microphone level meter. During recording, a warning appears after sustained silence.
3. Write or paste a script, show the teleprompter, and drag or resize it near your webcam. Adjust font size, speed, and opacity.
4. Click **Record** or press `Ctrl+Shift+R`. A cancellable countdown runs first. The teleprompter can start scrolling when recording begins. **Retake** discards the current take and starts a fresh countdown.
5. Stop to review the MP4, then **Save** to choose a filename and folder, or **Retake**.

Open the header gear for **Settings**. Choose a countdown from 3–10 seconds, turn mirroring or automatic prompter scrolling on or off, set the default save folder, and view keyboard shortcuts. Changes persist across launches. Mirroring applies to the preview, review, and saved MP4. Capture settings lock while a take is in progress or awaiting review.

`Space` plays or pauses teleprompter scrolling, or playback during review. `R` restarts the script. Shortcuts work inside the app and pause while typing or using a dialog.

## Limits

- Windows 11 is the supported platform. Other operating systems are not supported.
- Recording requires a camera and microphone, with 720p or 1080p at 30 FPS. Available quality depends on the camera.
- Recordings warn at 14 minutes and stop at 15 minutes. There is no pause, video editing, or transcription.
- Export uses direct H.264/AAC MP4 recording. If the bundled runtime cannot record that format, recording is unavailable.
- Background blur quality depends on lighting, motion, and hardware. If segmentation fails, recording continues without blur.

## Local data and privacy

The segmentation models and WASM runtime are bundled with the app, and external network requests are blocked while it runs. Installing dependencies and building the app require network access when the needed packages are not cached.

Preferences, including your script, live in `%APPDATA%/emcorder/preferences.json`. In-progress takes stream to `%APPDATA%/emcorder/takes/` and are copied to the chosen folder on save without overwriting existing files. A failed save keeps the temporary take for another attempt.

Temporary files retained after closing or a crash are not automatically restored into the studio. An interrupted recording may be incomplete or unplayable. Save takes you want to keep before closing the app.

## Maintenance

EmCorder is actively maintained. Bug reports and contributions are welcome through GitHub issues and pull requests. For a recording or device problem, include your Windows version, camera and microphone models, selected quality, and steps to reproduce it. Do not include private recordings or scripts unless you intend to share them publicly.

## License and documentation

The project code is available under the [MIT license](LICENSE). Bundled third-party assets retain their own licenses; see the [third-party notices](docs/third-party-notices.md).

- [Changelog](CHANGELOG.md)
- [Branding assets](src/renderer/public/branding/README.md)
