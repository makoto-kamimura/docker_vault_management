declare const __DEV__: boolean;

declare namespace NodeJS {
  interface ProcessEnv {
    EXPO_PUBLIC_LV_DEV_CORE?: string;
    EXPO_PUBLIC_LV_FAKE_CORE?: string;
    EXPO_PUBLIC_LV_FAKE_LOCKED?: string;
    EXPO_PUBLIC_LV_FAKE_ROUTE?: string;
  }
}
