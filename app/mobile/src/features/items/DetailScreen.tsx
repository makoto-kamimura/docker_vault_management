import type { ItemDetail } from '@localvault/core';
import { Copy, ExternalLink, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';
import {
  Avatar,
  Badge,
  Banner,
  BottomSheet,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  IconButton,
  ListRow,
  Screen,
  Section,
  Text,
} from '../../components';
import { t } from '../../i18n';
import { formatDate } from '../../lib/format';
import { nav } from '../../lib/nav';
import { makeStyles, useTheme } from '../../theme';
import { useItemDetail } from './useItemDetail';

const useStyles = makeStyles((th) => ({
  hero: { flexDirection: 'row', alignItems: 'center', gap: th.space[4] },
  heroText: { flex: 1, gap: th.space[1] },
  field: { paddingVertical: th.space[2], gap: th.space[1] },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: th.space[2] },
  value: { flex: 1 },
  stack: { gap: th.space[2] },
  cmpRow: { flexDirection: 'row', gap: th.space[3] },
  cmpCol: { flex: 1, gap: th.space[1] },
}));

function Field({
  label,
  children,
  trailing,
}: {
  label: string;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const s = useStyles();
  return (
    <View style={s.field}>
      <Text variant="caption" tone="secondary">
        {label}
      </Text>
      <View style={s.fieldRow}>
        <View style={s.value}>{children}</View>
        {trailing}
      </View>
    </View>
  );
}

function CompareColumn({ title, d }: { title: string; d: ItemDetail | null }) {
  const s = useStyles();
  return (
    <View style={s.cmpCol}>
      <Text variant="footnote" weight="semibold" tone="accent">
        {title}
      </Text>
      {d === null ? (
        <Text tone="secondary">{t('detail.notFound')}</Text>
      ) : (
        <>
          <Text weight="semibold">{d.title}</Text>
          <Text variant="footnote">{d.username}</Text>
          {d.urls.map((u) => (
            <Text key={u.url} variant="footnote" tone="secondary" numberOfLines={2}>
              {u.url}
            </Text>
          ))}
          {d.notes !== '' && (
            <Text variant="footnote" tone="secondary" numberOfLines={6}>
              {d.notes}
            </Text>
          )}
          <Text variant="caption" tone="tertiary">
            {t('detail.updatedAt', { date: formatDate(d.updatedAt) })}
          </Text>
        </>
      )}
    </View>
  );
}

export function DetailScreen({ id }: { id: string }) {
  const s = useStyles();
  const th = useTheme();
  const d = useItemDetail(id);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [confirmHistory, setConfirmHistory] = useState(false);
  const [compare, setCompare] = useState(false);
  const item = d.item;

  if (d.missing) {
    return (
      <Screen onBack={nav.back}>
        <EmptyState title={t('detail.notFound')} icon={Trash2} />
      </Screen>
    );
  }
  if (item === null) return <Screen onBack={nav.back}>{null}</Screen>;

  return (
    <Screen
      testID="detail-screen"
      onBack={nav.back}
      footer={
        item.trashedAt === null ? (
          <View style={{ flexDirection: 'row', gap: th.space[3], paddingBottom: th.space[3] }}>
            <Button
              style={{ flex: 1 }}
              variant="secondary"
              icon={Pencil}
              label={t('detail.edit')}
              testID="detail-edit"
              onPress={() => nav.push(`/item/${id}/edit`)}
            />
            <Button
              style={{ flex: 1 }}
              variant="danger"
              icon={Trash2}
              label={t('detail.trash')}
              onPress={() => setConfirmTrash(true)}
            />
          </View>
        ) : undefined
      }
    >
      <View style={s.hero}>
        <Avatar title={item.title} size={56} />
        <View style={s.heroText}>
          <Text variant="title2" accessibilityRole="header">
            {item.title === '' ? t('items.untitled') : item.title}
          </Text>
          <Text variant="caption" tone="tertiary">
            {t('detail.updatedAt', { date: formatDate(item.updatedAt) })}
          </Text>
        </View>
      </View>

      {item.trashedAt !== null && <Banner kind="warning" message={t('detail.trashed')} />}

      {item.isConflictCopy && (
        <Banner kind="warning" title={t('detail.conflictTitle')} message={t('detail.conflictBody')}>
          <View style={s.stack}>
            <Button
              variant="secondary"
              label={t('detail.compare')}
              onPress={() => setCompare(true)}
            />
            <Button
              variant="primary"
              label={t('detail.keepCopy')}
              onPress={() => void d.keepCopy()}
            />
            <Button
              variant="ghost"
              label={t('detail.deleteCopy')}
              onPress={() => void d.deleteCopy()}
            />
          </View>
        </Banner>
      )}

      <Card>
        <Field
          label={t('detail.username')}
          trailing={
            item.username !== '' ? (
              <IconButton
                testID="detail-copy-user"
                icon={Copy}
                label={t('items.copyUser')}
                onPress={() => void d.copy('username')}
              />
            ) : undefined
          }
        >
          <Text selectable={false}>{item.username === '' ? '—' : item.username}</Text>
        </Field>
        <Field
          label={t('detail.password')}
          trailing={
            item.hasPassword ? (
              <View style={{ flexDirection: 'row' }}>
                <IconButton
                  testID="detail-reveal"
                  icon={d.password === null ? Eye : EyeOff}
                  label={d.password === null ? t('a11y.revealPassword') : t('a11y.hidePassword')}
                  onPress={() => void d.toggleReveal()}
                />
                <IconButton
                  testID="detail-copy-pass"
                  icon={Copy}
                  label={t('items.copyPass')}
                  onPress={() => void d.copy('password')}
                />
              </View>
            ) : undefined
          }
        >
          <Text variant="mono" testID="detail-password">
            {!item.hasPassword
              ? t('detail.noPassword')
              : d.password === null
                ? '••••••••••••'
                : d.password}
          </Text>
        </Field>
      </Card>

      {item.urls.length > 0 && (
        <Section title={t('detail.urls')}>
          {item.urls.map((u) => (
            <ListRow
              key={u.url}
              title={u.url}
              subtitle={t(u.match === 'domain' ? 'detail.match.domain' : 'detail.match.host')}
              icon={ExternalLink}
              accessibilityHint={t('detail.openUrl')}
              onPress={() => void d.openUrl(u.url)}
              chevron={false}
            />
          ))}
        </Section>
      )}

      {item.androidApps.length > 0 && (
        <Section title={t('detail.apps')}>
          {item.androidApps.map((a) => (
            <ListRow
              key={a.packageName}
              title={a.label ?? a.packageName}
              subtitle={a.packageName}
              trailing={
                <Button
                  variant="ghost"
                  label={t('detail.unlink')}
                  onPress={() => void d.unlinkApp(a.packageName)}
                />
              }
            />
          ))}
        </Section>
      )}

      {item.notes !== '' && (
        <Card>
          <Field label={t('detail.notes')}>
            <Text>{item.notes}</Text>
          </Field>
        </Card>
      )}

      {item.hasPassword && (
        <Section title={t('detail.history')}>
          {d.history.length === 0 ? (
            <ListRow title={t('detail.historyEmpty')} />
          ) : (
            d.history.map((h) => (
              <ListRow
                key={h.index}
                title={h.revealed ?? '••••••••••••'}
                subtitle={formatDate(h.changedAt)}
                trailing={
                  <View style={{ flexDirection: 'row' }}>
                    <IconButton
                      icon={h.revealed === null ? Eye : EyeOff}
                      label={
                        h.revealed === null ? t('a11y.revealPassword') : t('a11y.hidePassword')
                      }
                      onPress={() => void d.toggleHistory(h.index)}
                    />
                    <IconButton
                      icon={Copy}
                      label={t('detail.copy')}
                      onPress={() => void d.copyHistory(h.index)}
                    />
                  </View>
                }
              />
            ))
          )}
          {d.history.length > 0 && (
            <ListRow
              destructive
              title={t('detail.historyClear')}
              onPress={() => setConfirmHistory(true)}
              chevron={false}
            />
          )}
        </Section>
      )}

      <ConfirmDialog
        visible={confirmTrash}
        title={t('detail.trashConfirmTitle')}
        message={t('detail.trashConfirmBody')}
        confirmLabel={t('detail.trash')}
        destructive
        onCancel={() => setConfirmTrash(false)}
        onConfirm={() => {
          setConfirmTrash(false);
          void d.moveToTrash();
        }}
      />
      <ConfirmDialog
        visible={confirmHistory}
        title={t('detail.historyClear')}
        message={t('detail.historyClearConfirm')}
        confirmLabel={t('detail.historyClear')}
        destructive
        onCancel={() => setConfirmHistory(false)}
        onConfirm={() => {
          setConfirmHistory(false);
          void d.clearHistory();
        }}
      />
      <BottomSheet
        visible={compare}
        onClose={() => setCompare(false)}
        title={t('detail.compareTitle')}
      >
        <View style={s.cmpRow}>
          <CompareColumn title={t('detail.compareThis')} d={item} />
          <CompareColumn title={t('detail.compareOriginal')} d={d.original} />
        </View>
        <Button variant="ghost" label={t('common.close')} onPress={() => setCompare(false)} />
      </BottomSheet>
      {item.isConflictCopy && <Badge label={t('items.conflictBadge')} tone="danger" />}
    </Screen>
  );
}
