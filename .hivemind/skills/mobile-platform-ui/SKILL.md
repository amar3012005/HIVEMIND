---
name: mobile-platform-ui
description: Build and review responsive Capacitor and web mobile interfaces for iOS and Android, including chat, keyboard behavior, accessible platform materials and document Preview. Use for mobile UI implementation and visual verification; retain the existing framework and product theme.
---
# Mobile platform UI

Identify the actual owner: outer React chrome, native DSH components, or Capacitor Swift/Java. Compare current source and deployed revision before editing. Preserve app permissions, session/stream ownership and the existing design language. Platform principles guide implementation; they do not authorize replacing the chat engine.

## Platform decisions

Use Apple's current HIG for iPhone/iPad; use Android Material/accessibility guidance for Android. Fetch applicable official references before claiming current platform compliance. Native pt/dp and CSS pixels are different coordinate systems: verify viewport scale and the actual hit region on device. Start with 44pt iOS and 48dp Android interactive targets; compact icons can sit within larger padded targets. Avoid overlapping hit regions and nested interactive controls.

Apple Liquid Glass belongs to navigation and controls. Native UIKit/SwiftUI material APIs are different from CSS backdrop filters in WKWebView. Describe implemented web effects accurately. Apply bounded translucent chrome with legible content, opaque fallback, reduced transparency, reduced motion and increased contrast handling. Keep message/document surfaces readable. Avoid continuous distortion and heavy blur over scrolling content. Native system preferences require verified propagation if browser media queries do not reflect them.

For Capacitor, retain native permission/picker/share/back behavior. Verify Android Back dismisses the top transient surface before leaving the room. Preserve iOS system-browser OAuth and app-return handling. Do not claim Swift/iOS runtime behavior from Linux compilation or desktop emulation.

## Chat and Preview

Own the visual viewport and each safe-area inset once. Keep the composer above the software keyboard without reducing height twice. Preserve drafts, scroll position and newest-message behavior across rotation, keyboard close and app resume. Use bounded older-history paging; never load years of history to show one room.

Make identity and activity clear with consistent avatars, sender colors, dates and timestamps. Preserve the product's separate Brain/Runtime/employee semantics. One primary Send/Stop control; secondary voice/attachment controls remain available. Wrap long text/URLs; local scrolling inside code/table content must not become whole-page horizontal overflow. Do not silently truncate a complete answer.

Preview uses the existing authorized artifact reader. Fit the viewer to the visible viewport, with reachable named close/download controls, correct document-local scrolling and safe-area padding. Preserve private download authentication and isolate untrusted HTML from native bridge/session authority. Verify HTML, image and PDF separately; one image check does not prove PDF behavior.

## Evidence

Exercise actual current components/styles with realistic long/dense data at small-phone, larger-phone, tablet, landscape and keyboard-sized viewports. Check large text, focus, reduced motion/transparency, contrast and every icon-only accessible name. Save screenshots and geometry; refresh generated CSS before interpreting them. Missing fonts in offline fixtures are a proof limit, not production typography evidence.

Separate source checks, compiled/browser fixtures, deployed authenticated checks and physical-device results. Record exact SHAs and remaining gaps. Inspect meaningful interaction/scroll responsiveness rather than presenting a Lighthouse score as proof of chat responsiveness. Use available Playwright/browser tools for verification and real devices for platform behavior.

## Official references

- Apple layout: https://developer.apple.com/design/human-interface-guidelines/layout
- Apple accessibility: https://developer.apple.com/design/human-interface-guidelines/accessibility
- Apple typography: https://developer.apple.com/design/human-interface-guidelines/typography
- Apple materials: https://developer.apple.com/design/human-interface-guidelines/materials
- Native Liquid Glass: https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass
- Android accessible controls: https://developer.android.com/develop/ui/compose/accessibility/api-defaults
- Android adaptive layouts: https://developer.android.com/develop/ui/compose/layouts/adaptive
- Android insets: https://developer.android.com/develop/ui/compose/system/insets
- Capacitor keyboard: https://capacitorjs.com/docs/apis/keyboard
