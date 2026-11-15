import * as Haptics from 'expo-haptics';

// Haptics are decoration: never let a failure (simulator, unsupported device) surface.
function run(fn: () => Promise<void>): void {
  fn().catch(() => undefined);
}

export const haptics = {
  success: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  error: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
  warning: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  tap: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  select: () => run(() => Haptics.selectionAsync()),
};
