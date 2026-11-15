import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';
import { t as tr } from '../i18n';
import { haptics } from '../lib/haptics';
import { makeStyles, useTheme } from '../theme';
import { Button } from './Button';
import { Text } from './Text';

const useStyles = makeStyles((t) => ({
  wrap: { borderRadius: t.radius.xl, overflow: 'hidden', aspectRatio: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: t.space[3],
    padding: t.space[5],
  },
  frame: {
    ...({ position: 'absolute' } as const),
    top: '15%',
    left: '15%',
    right: '15%',
    bottom: '15%',
    borderRadius: t.radius.lg,
    borderWidth: 3,
    borderColor: '#FFFFFFCC',
  },
  hint: {
    ...({ position: 'absolute' } as const),
    bottom: t.space[3],
    left: 0,
    right: 0,
    alignItems: 'center',
  },
}));

/**
 * expo-camera QR reader with permission states. `onScan` fires once per distinct payload within a
 * second (camera frames repeat). Payload contents are never logged.
 */
export function QrScanner({
  onScan,
  active = true,
}: {
  onScan: (data: string) => void;
  active?: boolean;
}) {
  const t = useTheme();
  const s = useStyles();
  const [permission, requestPermission] = useCameraPermissions();
  const last = useRef<{ data: string; at: number } | null>(null);

  let body: React.ReactNode;
  if (permission === null) {
    body = (
      <View style={s.center} accessibilityLabel={tr('qr.loading')}>
        <ActivityIndicator color="#FFFFFF" />
      </View>
    );
  } else if (!permission.granted) {
    const canAsk = permission.canAskAgain;
    body = (
      <View style={[s.center, { backgroundColor: t.color.bgSunken }]}>
        <Text variant="title3" align="center">
          {tr('qr.permission.title')}
        </Text>
        <Text variant="footnote" tone="secondary" align="center">
          {canAsk ? tr('qr.permission.body') : tr('qr.permission.denied')}
        </Text>
        <Button
          label={canAsk ? tr('qr.permission.allow') : tr('qr.permission.settings')}
          fullWidth={false}
          onPress={() => {
            if (canAsk) void requestPermission();
            else void Linking.openSettings();
          }}
        />
      </View>
    );
  } else {
    body = (
      <>
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={
            active
              ? ({ data }) => {
                  const now = Date.now();
                  if (last.current && last.current.data === data && now - last.current.at < 1000) {
                    last.current.at = now;
                    return;
                  }
                  last.current = { data, at: now };
                  haptics.success();
                  onScan(data);
                }
              : undefined
          }
        />
        <View style={s.frame} pointerEvents="none" accessibilityLabel={tr('a11y.scanFrame')} />
        <View style={s.hint} pointerEvents="none">
          <Text variant="footnote" style={{ color: '#FFFFFF' }}>
            {tr('qr.hint')}
          </Text>
        </View>
      </>
    );
  }
  return <View style={s.wrap}>{body}</View>;
}
