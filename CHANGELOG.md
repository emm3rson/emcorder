# Changelog

## Unreleased

## 0.1.1 - 2026-10-24

- Use a visible installer wizard with a Finish page and launch option, create desktop and Start menu shortcuts, repair shortcut metadata on reinstall, and set the runtime Windows app identity.

## 0.1.0 - 2026-10-24

- Added a Windows x64 installer for the current user, manual upgrades, and Start menu integration while retaining local data on uninstall.
- Show the package version in Settings and bring the existing window forward when EmCorder is launched again.
- Added release and versioning guidance for local builds and future distribution.
- Moved blur, microphone-quiet, quality-fallback, and automatic-stop advisories into dismissible toasts that keep cards stable, suppress repeated warnings per take or retry, and pause while hovered, focused, or behind dialogs. Actionable errors remain visible in context.
- Added remembered brightness, contrast, and saturation controls with a consistent 50–150% range in a collapsible Image card, with Reset and matching preview/MP4 output across background-blur modes.
- Replaced the header wordmark image with the primary logo symbol in its original colors beside bold EmCorder text with a Slate-to-Soft-Silver gradient.
- Expanded the overlay sliders to use the available prompter width and hid them below 480px, keeping play and restart available alongside the sidebar controls.
- Reused fixed GPU texture storage for background blur and skipped unchanged mask uploads while retaining per-frame source updates and the existing blur mipmaps.
- Relaxed background-blur refinement for confident clothing, accessories, and narrow foreground details, with a gentler edge cutoff while retaining ambiguous-background suppression.
- Improved background-blur timing with completion-driven segmentation, mask expiry measured from the sampled frame, fewer MediaPipe mask copies, and time-aware smoothing that resets after pauses or reactivation.
- Clear preference-save warnings after a successful update, and ignore superseded update results so settings show the current persistence status.
- Removed unused capture diagnostics and status state left behind by the diagnostics UI removal, avoiding unnecessary work and studio renders during capture.

- Prepared the source repository for publication with MIT licensing, public setup and usage documentation, and local-only internal guides.
- Measured the studio countdown test from the Record click so time spent checking Settings does not cause a false early-start failure.

## 0.0.1 - 2026-10-23

- Added a Windows 11 camera studio with remembered 720p and 1080p quality, camera and microphone selection, and device recovery.
- Added local background blur with Light, Standard, and Strong presets, with unblurred recording available when segmentation fails.
- Added a draggable, resizable teleprompter with script editing, automatic scrolling, keyboard shortcuts, and remembered appearance and position. The overlay is excluded from recordings.
- Added direct H.264/AAC MP4 recording, a configurable countdown, Stop and Retake, a microphone meter and silence warning, and a 15-minute recording limit.
- Added take review, local filenames, destination selection, and saves that preserve existing files and retain temporary takes after a failed save.
- Added remembered settings for countdown, mirroring, automatic prompter start, and the default save folder.
- Added EmCorder branding, Windows folder packaging, unit tests, and synthetic recording workflow checks.
