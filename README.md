# Zesty EQ for iOS

iOS port of Zesty EQ (formerly Vendroid) — a custom Discord client that loads discord.com and injects Vencord with Zesty EQ's real-time audio processing engine.

**Minimum Deployment Target:** iOS 14.0  
**Supported Devices:** iPhone, iPad, iPod touch

## Features

- Full Discord web experience via WKWebView
- Vencord integration (loaded from GitHub releases)
- Zesty EQ real-time audio processor with:
  - 5-band Parametric EQ with visual graph
  - Preamp, Pan, Stereo Width controls
  - FX Rack: Drive, Saturation, Reverb, Delay, Chorus
  - Warfare: Vacuum, Sabotage, Ghost, Siren, Beast Mode, Talk Mode
  - Soundboard with file upload & YouTube download
  - Audio recorder (WebM/Opus)
- Desktop/Mobile user agent toggle
- Floating draggable settings panel (same as Android version)

## Setup Instructions

### Prerequisites

- macOS with Xcode 13+ (iOS 15+ simulator/target)
- Apple Developer account (for device deployment)

### Steps

1. **Create Xcode project:**
   - Open Xcode → File → New → Project
   - Choose iOS → App → Next
   - Product Name: `ZestyEQ`
   - Interface: SwiftUI
   - Language: Swift
   - Minimum Deployment: iOS 14.0
   - Uncheck "Use Core Data", "Include Tests"

2. **Add source files:**
   - Copy all files from `ZestyEQ/` into the Xcode project
   - Make sure `Copy items if needed` is checked
   - Add the `Resources/` folder as a "Folder Reference" so JS files are in the bundle

3. **Configure Info.plist:**
   - The provided `Info.plist` already has necessary permissions.
   - Ensure `Info.plist` is set as the target's Info file in Build Settings.

4. **Add JS files to Copy Bundle Resources:**
   - In Build Phases → Copy Bundle Resources, add:
     - `vencord_mobile.js`
     - `zesty_eq.js`

5. **App Transport Security:**
   - The Info.plist includes `NSAllowsArbitraryLoads` for loading Discord/Vencord content.

6. **Provisioning:**
   - In Signing & Capabilities, select your team and set a unique bundle identifier.

### Build & Run

1. Select a simulator (iPhone 11 or newer recommended) or your device
2. Press Cmd+R to build and run
3. Grant microphone and camera permissions when prompted
4. The app loads Discord and injects Zesty EQ after page load

## Key Differences from Android Version

| Android | iOS |
|---------|-----|
| WebView + WebChromeClient | WKWebView + WKNavigationDelegate |
| `@JavascriptInterface` | `WKUserContentController` script handler |
| `AudioWorklet` (unsupported in WKWebView) | `ScriptProcessorNode` (deprecated but works) |
| `SharedPreferences` | `UserDefaults` |
| Android-specific back handling | iOS navigation via webkit message handler |
| XML layouts | SwiftUI views |

## Technical Notes

- **Audio Processing:** The original `AudioWorklet` was replaced with `ScriptProcessorNode` (deprecated but fully functional in WKWebView). All DSP algorithms remain identical.
- **JavaScript Bridge:** Communication between Swift and JS uses `WKUserContentController` via `window.webkit.messageHandlers.vencordMobile.postMessage()`.
- **Vencord Load:** The Vencord `browser.js` runtime is fetched from GitHub on each page load.
- **YouTube Downloads:** Works via `postMessage` bridge — requires a native backend or server-side proxy in production.

## License

Same as original Vendroid project.
