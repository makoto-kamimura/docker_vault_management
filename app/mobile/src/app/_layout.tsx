import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Text, ToastProvider } from '../components';
import { fakeStartRoute } from '../env';
import { RouteGuard } from '../features/navigation/RouteGuard';
import { SessionProvider } from '../features/session/SessionProvider';
import { nav } from '../lib/nav';
import { useLockStore } from '../state/lockStore';
import { ThemeProvider, useTheme } from '../theme';

function Splash() {
  const t = useTheme();
  return <View style={{ flex: 1, backgroundColor: t.color.bg }} />;
}

function BootFailure({ message }: { message: string }) {
  const t = useTheme();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: t.color.bg,
        padding: 24,
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <Text variant="title2">LocalVault</Text>
      <Text tone="secondary">{message}</Text>
    </View>
  );
}

function Navigator() {
  const t = useTheme();
  const lockState = useLockStore((s) => s.lockState);
  useEffect(() => {
    // Visual checks only (EXPO_PUBLIC_LV_FAKE_ROUTE + FakeVaultCore): open a route after boot.
    if (fakeStartRoute !== null && lockState !== 'unknown') {
      const id = setTimeout(() => nav.push(fakeStartRoute as string), 400);
      return () => clearTimeout(id);
    }
  }, [lockState]);
  return (
    <>
      <StatusBar style={t.name === 'dark' ? 'light' : 'dark'} />
      <RouteGuard />
      {lockState === 'unknown' ? (
        <Splash />
      ) : (
        <Stack
          screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.color.bg } }}
        >
          <Stack.Screen name="(setup)" />
          <Stack.Screen name="(locked)" options={{ animation: 'fade' }} />
          <Stack.Screen name="(app)" options={{ animation: 'fade' }} />
        </Stack>
      )}
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <ToastProvider>
            <SessionProvider fallback={<Splash />} failure={(m) => <BootFailure message={m} />}>
              <Navigator />
            </SessionProvider>
          </ToastProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
