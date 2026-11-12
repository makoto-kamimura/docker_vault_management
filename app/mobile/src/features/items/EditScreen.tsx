import { Plus, Sparkles, Trash2 } from 'lucide-react-native';
import { Controller, useWatch } from 'react-hook-form';
import { View } from 'react-native';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  IconButton,
  PasswordField,
  Screen,
  SegmentedControl,
  StrengthMeter,
  SwitchRow,
  Text,
  TextField,
} from '../../components';
import { t } from '../../i18n';
import { nav } from '../../lib/nav';
import { makeStyles } from '../../theme';
import { fieldLimits } from './formSchema';
import { useItemForm } from './useItemForm';

const useStyles = makeStyles((th) => ({
  stack: { gap: th.space[4] },
  urlRow: { gap: th.space[2], paddingBottom: th.space[3] },
  urlLine: { flexDirection: 'row', alignItems: 'flex-end', gap: th.space[2] },
  grow: { flex: 1 },
}));

function PasswordWithMeter({
  control,
}: {
  control: ReturnType<typeof useItemForm>['form']['control'];
}) {
  const pw = useWatch({ control, name: 'password' });
  return pw === '' ? null : <StrengthMeter password={pw} />;
}

export function EditScreen({ id }: { id?: string }) {
  const s = useStyles();
  const f = useItemForm(id);
  const { control, formState } = f.form;
  const err = (name: keyof typeof fieldLimits | 'urls') => {
    const m = formState.errors[name]?.message;
    if (!m) return null;
    const key = m as Parameters<typeof t>[0];
    return t(key, { max: fieldLimits[name] });
  };

  if (f.missing) {
    return (
      <Screen onBack={nav.back}>
        <EmptyState icon={Trash2} title={t('detail.notFound')} />
      </Screen>
    );
  }

  return (
    <Screen
      testID="edit-screen"
      title={f.isNew ? t('form.newTitle') : t('form.editTitle')}
      onBack={nav.back}
      footer={
        <View style={{ paddingBottom: 12 }}>
          <Button
            testID="form-save"
            label={t('form.save')}
            loading={f.saving}
            disabled={f.loading || (f.isNew && !formState.isDirty)}
            onPress={() => void f.submit()}
          />
        </View>
      }
    >
      <View style={s.stack}>
        <Controller
          control={control}
          name="title"
          render={({ field }) => (
            <TextField
              testID="form-title"
              label={t('form.title')}
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              error={formState.touchedFields.title ? err('title') : null}
              maxLength={fieldLimits.title + 1}
              returnKeyType="next"
            />
          )}
        />
        <Controller
          control={control}
          name="username"
          render={({ field }) => (
            <TextField
              testID="form-username"
              label={t('form.username')}
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              error={err('username')}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="username"
            />
          )}
        />
        <Controller
          control={control}
          name="password"
          render={({ field }) => (
            <View style={{ gap: 8 }}>
              <PasswordField
                testID="form-password"
                label={t('form.password')}
                hint={!f.isNew && f.hasPassword ? t('form.passwordKeep') : undefined}
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                error={err('password')}
                meter={<PasswordWithMeter control={control} />}
              />
              <Button
                testID="form-generate"
                variant="secondary"
                icon={Sparkles}
                label={t('form.generate')}
                onPress={() => nav.push('/generator')}
              />
            </View>
          )}
        />

        <View style={{ gap: 8 }}>
          <Text variant="footnote" weight="semibold" tone="secondary">
            {t('form.urls')}
          </Text>
          {f.urls.fields.map((row, i) => (
            <Card key={row.id}>
              <View style={s.urlRow}>
                <View style={s.urlLine}>
                  <View style={s.grow}>
                    <Controller
                      control={control}
                      name={`urls.${i}.url`}
                      render={({ field }) => (
                        <TextField
                          label={t('form.urls')}
                          placeholder={t('form.urlPlaceholder')}
                          value={field.value}
                          onChangeText={field.onChange}
                          onBlur={field.onBlur}
                          autoCapitalize="none"
                          autoCorrect={false}
                          keyboardType="url"
                          error={
                            formState.errors.urls?.[i]?.url?.message ? t('form.urlInvalid') : null
                          }
                        />
                      )}
                    />
                  </View>
                  <IconButton
                    icon={Trash2}
                    tone="danger"
                    label={t('form.urlRemove')}
                    onPress={() => f.urls.remove(i)}
                  />
                </View>
                <Controller
                  control={control}
                  name={`urls.${i}.match`}
                  render={({ field }) => (
                    <SegmentedControl
                      label={t('form.match')}
                      value={field.value}
                      onChange={field.onChange}
                      options={[
                        { value: 'domain', label: t('form.match.domain') },
                        { value: 'host', label: t('form.match.host') },
                      ]}
                    />
                  )}
                />
              </View>
            </Card>
          ))}
          {formState.errors.urls?.message !== undefined && (
            <Text variant="footnote" tone="danger">
              {err('urls')}
            </Text>
          )}
          <Button
            testID="form-add-url"
            variant="ghost"
            icon={Plus}
            label={t('form.urlAdd')}
            disabled={f.urls.fields.length >= fieldLimits.urls}
            onPress={() => f.urls.append({ url: '', match: 'domain' })}
          />
        </View>

        <Controller
          control={control}
          name="notes"
          render={({ field }) => (
            <TextField
              label={t('form.notes')}
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              error={err('notes')}
              multiline
              numberOfLines={4}
            />
          )}
        />
        <Controller
          control={control}
          name="favorite"
          render={({ field }) => (
            <SwitchRow
              title={t('form.favorite')}
              value={field.value}
              onValueChange={field.onChange}
            />
          )}
        />
      </View>

      <ConfirmDialog
        visible={f.confirmLeave}
        title={t('form.discardTitle')}
        message={t('form.discardBody')}
        confirmLabel={t('form.discard')}
        cancelLabel={t('form.keepEditing')}
        destructive
        onCancel={f.keepEditing}
        onConfirm={f.discard}
      />
    </Screen>
  );
}
