// Spec §16.1. Plugins whose native code does not exist yet are kept as TODO comments.
import type { ConfigContext, ExpoConfig } from 'expo/config';

// §19 Q8. Override for signing with your own Apple team (a free Personal Team needs a unique ID):
//   LV_BUNDLE_ID=jp.example.uchikagi npx expo run:ios --device --configuration Release
const BUNDLE_ID = process.env.LV_BUNDLE_ID ?? 'com.example.localvault';
// A free Apple ID (Personal Team) cannot sign the Push Notifications capability: LV_PUSH=0 leaves
// out the expo-notifications plugin and its aps-environment entitlement. The app then checks
// pending PC approvals while it is open (usePendingApprovals) instead of receiving pushes.
const PUSH = process.env.LV_PUSH !== '0';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  // `name` is also the Xcode project / scheme name, so it stays the identifier. The name people
  // see is うちカギ (CFBundleDisplayName below).
  // TODO(native wave): Android label (strings.xml app_name) once the Android build is in scope.
  name: 'LocalVault',
  slug: 'localvault',
  scheme: 'localvault',
  version: '0.4.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  // New Architecture is always on in SDK 58 / RN 0.88 (the flag no longer exists).
  icon: './assets/icon.png',
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: false,
    // TODO(native wave): appleTeamId
    infoPlist: {
      CFBundleDisplayName: 'うちカギ',
      NSFaceIDUsageDescription: '保存したログイン情報を保護するために Face ID を使用します',
      NSCameraUsageDescription: 'PC の登録や復旧で QR コードを読み取るためにカメラを使用します',
      ITSAppUsesNonExemptEncryption: false,
    },
    // TODO(native wave): entitlements (autofill-credential-provider, application-groups,
    // keychain-access-groups) once the Swift targets exist.
  },
  android: {
    package: BUNDLE_ID,
    allowBackup: false,
    // TODO(native wave): googleServicesFile: './google-services.json' (FCM)
    permissions: ['android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS'],
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#1F4A86' },
  },
  plugins: [
    'expo-router',
    [
      'expo-build-properties',
      { ios: { deploymentTarget: '17.0' }, android: { minSdkVersion: 30 } },
    ],
    ...(PUSH ? ['expo-notifications'] : []),
    ['expo-camera', { cameraPermission: 'QR コードを読み取るためにカメラを使用します' }],
    // TODO(native wave): '@bacons/apple-targets',
    // TODO(native wave): './plugins/with-psl',
    // TODO(native wave): './plugins/with-network-security-config',
    // TODO(native wave): './plugins/with-ios-privacy-cover',
  ],
  experiments: { typedRoutes: true },
});
