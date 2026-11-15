import { Stack } from 'expo-router';
import { AppEffects } from '../../features/approvals/AppEffects';
import { useTheme } from '../../theme';

// The next waves add item, device, settings and approval routes inside this group.
export default function AppLayout() {
  const t = useTheme();
  return (
    <>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.color.bg } }}>
        <Stack.Screen name="generator" options={{ presentation: 'modal' }} />
      </Stack>
      <AppEffects />
    </>
  );
}
