import { useReducedMotion } from 'react-native-reanimated';

/** True when the user enabled Reduce Motion; animations must then be skipped or made instant. */
export function useReduceMotion(): boolean {
  return useReducedMotion();
}
