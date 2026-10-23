# Branding assets

The supplied SVG and PNG files are kept unchanged here. The studio uses `logo-primary.svg` directly on the light header, with a CSS brightness filter of 0.75 to improve contrast. `logo-dark` and `logo-white` are available for other light and dark surfaces.

`splash-screen.png` appears in the initial HTML while React loads, with no minimum display time or extra window. `app-icon-32.png` is the document icon. `app-icon.ico` is used by the Electron window and Windows packaging, with executable resource editing enabled and code signing disabled.

The ICO contains the supplied 32 px and 256 px PNGs plus 16, 48, 64, and 128 px versions resized from `app-icon-1024.png`. Regenerate it from these sources when changing the app icon.
