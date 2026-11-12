// Native push token registration (APNs / FCM direct; Expo's push relay is never used, §13.7).
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { ApiClient } from '../../api';

export async function registerPushToken(api: ApiClient): Promise<void> {
  const token = await Notifications.getDevicePushTokenAsync();
  await api.call('putPushToken', {
    body: { pushPlatform: Platform.OS === 'ios' ? 'apns' : 'fcm', token: String(token.data) },
  });
}
