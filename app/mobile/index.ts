// Entry point. The polyfill import MUST come first: @noble/hashes captures `globalThis.crypto`
// when it is first imported, and Hermes has no WebCrypto.
import './src/polyfills';
import 'expo-router/entry';
