# Releasing and versioning

## Versions

`package.json` supplies the installer and Settings version. Update both manifests with `npm version <version> --no-git-tag-version`.

- **Patch** (`0.1.0 → 0.1.1`): fixes and small refinements.
- **Minor** (`0.1.1 → 0.2.0`): new features; also breaking changes before 1.0.
- **Major** (`1.2.3 → 2.0.0`): breaking changes after 1.0. Choose 1.0 when the core workflow is ready for broader use.

Bump for distribution, not every commit. Never reuse a distributed version for changed binaries. Move completed `CHANGELOG.md` entries from `Unreleased` into a dated release section; document migrations.

## Release

1. Set the version and update affected docs.
2. Run checks appropriate to the changes (see [AGENTS.md](../AGENTS.md)), plus `git diff --check`.
3. Run `npm run dist` (includes type checking and build). Output: `release/EmCorder-Setup-<version>-x64.exe`.
4. Owner checks: fresh install, Settings version, blur, recording/playback/save, second launch, upgrade preserving settings/scripts, and uninstall retaining data. Use a disposable account or VM for uninstall checks. Report actual results; building alone does not verify installation.

The unsigned Windows 11 x64 wizard installs for the current user, repairs desktop/Start shortcuts, and offers launch on Finish. To update, save the take, close EmCorder, and run the newer installer. Publishing, signing, and automatic updates are separate tasks. Commit/tag (`v<version>`) only when requested.

## Preserve

- Keep `appId: local.emcorder.app`, package name `emcorder`, and `%APPDATA%/emcorder` stable.
- Keep `deleteAppDataOnUninstall: false`. Never remove scripts, preferences, temporary takes, or saved videos during upgrades/uninstall; migrate data when needed.
- Keep the UI version derived from `package.json` and generated `out/`, `release/`, and `tests/artifacts/` ignored.
