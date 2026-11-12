import { DEFAULT_GENERATOR_OPTIONS, type GeneratorOptions } from '@localvault/core';
import { useCallback, useEffect, useState } from 'react';
import { t } from '../../i18n';
import { nav } from '../../lib/nav';
import { useToastStore } from '../../state/toastStore';
import { describeError } from '../errors/messages';
import { useSession } from '../session/SessionProvider';
import { useGeneratorHandoff } from './generatorStore';
import { canDisable, clampLength, type classKeys } from './options';

export function useGenerator() {
  const { core } = useSession();
  const push = useToastStore((s) => s.push);
  const offer = useGeneratorHandoff((s) => s.offer);
  const [options, setOptions] = useState<GeneratorOptions>({ ...DEFAULT_GENERATOR_OPTIONS });
  const [value, setValue] = useState('');

  const regenerate = useCallback(
    async (o: GeneratorOptions) => {
      try {
        setValue(await core.generatePassword(o));
      } catch (e) {
        push('error', describeError(e) || t('gen.failed'));
      }
    },
    [core, push],
  );

  useEffect(() => {
    void regenerate(options);
  }, [options, regenerate]);

  const setLength = (n: number) => setOptions((o) => ({ ...o, length: clampLength(n) }));
  const toggleClass = (key: (typeof classKeys)[number]) =>
    setOptions((o) => {
      if (o[key] && !canDisable(o, key)) return o;
      return { ...o, [key]: !o[key] };
    });
  const toggleAmbiguous = () =>
    setOptions((o) => ({ ...o, excludeAmbiguous: !o.excludeAmbiguous }));

  const use = () => {
    offer(value);
    nav.back();
  };

  return {
    options,
    value,
    setLength,
    toggleClass,
    toggleAmbiguous,
    regenerate: () => regenerate(options),
    use,
  };
}
