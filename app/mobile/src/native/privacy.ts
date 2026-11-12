// HOOK POINT (spec §5.9 / NFR-07): iOS privacy cover when the app switches and Android FLAG_SECURE
// are implemented natively (config plugin `with-ios-privacy-cover` + the VaultCore module). The
// JS side only needs a place to toggle them for screens that must be shielded (recovery key, sheet).
// TODO(native wave): forward to the native module.
export function setScreenCaptureProtected(_enabled: boolean): void {
  // intentionally empty
}
