import { useFocusEffect, useNavigation, usePreventRemove } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Resolver, useFieldArray, useForm } from 'react-hook-form';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { useToastStore } from '../../state/toastStore';
import { describeError } from '../errors/messages';
import { useGeneratorHandoff } from '../generator/generatorStore';
import { useSession } from '../session/SessionProvider';
import { emptyForm, type FormValues, toItemInput, validateForm } from './formSchema';

const resolver: Resolver<FormValues> = async (values) =>
  validateForm(values) as unknown as Awaited<ReturnType<Resolver<FormValues>>>;

export function useItemForm(id?: string) {
  const { core } = useSession();
  const push = useToastStore((s) => s.push);
  const navigation = useNavigation();
  const [loading, setLoading] = useState(id !== undefined);
  const [missing, setMissing] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const pendingAction = useRef<unknown>(null);

  const form = useForm<FormValues>({ defaultValues: emptyForm, resolver, mode: 'onChange' });
  const urls = useFieldArray({ control: form.control, name: 'urls' });
  const { isDirty } = form.formState;

  useEffect(() => {
    if (id === undefined) return;
    let alive = true;
    core
      .getItem(id)
      .then((d) => {
        if (!alive) return;
        form.reset({
          title: d.title,
          username: d.username,
          password: '',
          urls: d.urls.map((u) => ({ url: u.url, match: u.match })),
          notes: d.notes,
          favorite: d.favorite,
        });
        setHasPassword(d.hasPassword);
        setLoading(false);
      })
      .catch(() => {
        if (alive) {
          setMissing(true);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [core, id, form.reset]);

  // A value chosen in /generator comes back through the in-memory handoff.
  useFocusEffect(
    useCallback(() => {
      const v = useGeneratorHandoff.getState().take();
      if (v !== null) form.setValue('password', v, { shouldDirty: true, shouldValidate: true });
    }, [form.setValue]),
  );

  // Unsaved-changes guard on back / swipe-back.
  const [dirtyGuard, setDirtyGuard] = useState(false);
  useEffect(() => setDirtyGuard(isDirty), [isDirty]);
  usePreventRemove(dirtyGuard, ({ data }) => {
    pendingAction.current = data.action;
    setConfirmLeave(true);
  });

  // Drop the plaintext password from the form when the screen unmounts.
  useEffect(() => () => form.setValue('password', ''), [form.setValue]);

  const submit = form.handleSubmit(async (v) => {
    setSaving(true);
    try {
      const d = await core.saveItem(toItemInput(v, id));
      setDirtyGuard(false);
      await new Promise<void>((r) => setTimeout(r, 50)); // let the guard release before navigating
      haptics.success();
      push('success', t('form.saved'));
      if (id === undefined) nav.replace(`/item/${d.id}`);
      else nav.back();
    } catch (e) {
      haptics.error();
      push('error', describeError(e) || t('form.saveFailed'));
    } finally {
      setSaving(false);
    }
  });

  const discard = () => {
    setConfirmLeave(false);
    setDirtyGuard(false);
    const action = pendingAction.current as Parameters<typeof navigation.dispatch>[0] | null;
    if (action) setTimeout(() => navigation.dispatch(action), 0);
  };

  return {
    form,
    urls,
    loading,
    missing,
    hasPassword,
    saving,
    submit,
    confirmLeave,
    discard,
    keepEditing: () => setConfirmLeave(false),
    isNew: id === undefined,
  };
}
