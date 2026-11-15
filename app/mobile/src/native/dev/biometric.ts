// DEVELOPMENT ONLY biometric: an Alert whose buttons exercise every branch (成功 / キャンセル /
// 失敗 / 無効化). The real Face ID / BiometricPrompt comes with the native module.
// EXPO_PUBLIC_LV_DEV_BIOMETRIC=success|cancel|fail|invalidated answers without the dialog
// (automation on a simulator).
import { VaultCoreError } from '@localvault/core';
import type { AuthToken, Biometric } from '@localvault/vault-engine';
import { Alert } from 'react-native';

type Answer = 'success' | 'cancel' | 'fail' | 'invalidated';

const scripted = (): Answer | null => {
  const v = process.env.EXPO_PUBLIC_LV_DEV_BIOMETRIC;
  return v === 'success' || v === 'cancel' || v === 'fail' || v === 'invalidated' ? v : null;
};

export class DevBiometric implements Biometric {
  /** Bumped by "無効化": gated keystore slots written before become unreadable (FR-13). */
  generation = 0;
  /** Runtime override of the scripted answer (set by the dev control file). */
  override: Answer | null = null;
  readonly #tokens = new WeakSet<object>();

  async availability() {
    return { available: true, kind: 'faceId' as const };
  }

  isValid(token: AuthToken | undefined): boolean {
    return token !== undefined && this.#tokens.has(token);
  }

  #ask(reason: string): Promise<Answer> {
    const fixed = this.override ?? scripted();
    if (fixed) return Promise.resolve(fixed);
    return new Promise((resolve) => {
      Alert.alert(
        '（開発用）生体認証',
        reason,
        [
          { text: '成功', onPress: () => resolve('success') },
          { text: 'キャンセル', style: 'cancel', onPress: () => resolve('cancel') },
          { text: '失敗', onPress: () => resolve('fail') },
          { text: '無効化', style: 'destructive', onPress: () => resolve('invalidated') },
        ],
        { cancelable: true, onDismiss: () => resolve('cancel') },
      );
    });
  }

  async authenticate(reason: string): Promise<AuthToken> {
    const answer = await this.#ask(reason);
    switch (answer) {
      case 'cancel':
        throw new VaultCoreError('E_AUTH_CANCELED');
      case 'fail':
        throw new VaultCoreError('E_AUTH_FAILED');
      case 'invalidated':
        this.generation++;
        throw new VaultCoreError('E_BIOMETRY_INVALIDATED');
      case 'success':
        break;
    }
    const token: AuthToken = { kind: 'biometric-auth' };
    this.#tokens.add(token);
    return token;
  }
}
