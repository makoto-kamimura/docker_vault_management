import { RotateCcw, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';
import {
  Avatar,
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  ListRow,
  Screen,
  Section,
} from '../../components';
import { t } from '../../i18n';
import { nav } from '../../lib/nav';
import { trashLabel } from '../items/model';
import { useTrash } from './useTrash';

export function TrashScreen() {
  const tr = useTrash();
  const [target, setTarget] = useState<string | null>(null);
  const [emptyAll, setEmptyAll] = useState(false);
  const items = tr.items ?? [];
  const now = Date.now();

  return (
    <Screen
      testID="trash-screen"
      title={t('trash.title')}
      onBack={nav.back}
      footer={
        items.length > 0 ? (
          <View style={{ paddingBottom: 12 }}>
            <Button
              variant="danger"
              label={t('trash.emptyAll')}
              onPress={() => setEmptyAll(true)}
            />
          </View>
        ) : undefined
      }
    >
      {tr.failed ? (
        <EmptyState
          icon={Trash2}
          title={t('items.loadFailed')}
          actionLabel={t('common.retry')}
          onAction={() => void tr.reload()}
        />
      ) : tr.items !== null && items.length === 0 ? (
        <EmptyState icon={Trash2} title={t('trash.empty.title')} message={t('trash.empty.body')} />
      ) : (
        <Section>
          {items.map((i) => (
            <ListRow
              key={i.id}
              testID={`trash-row-${i.id}`}
              title={i.title === '' ? t('items.untitled') : i.title}
              subtitle={trashLabel(i.trashedAt as string, now)}
              leading={<Avatar title={i.title} />}
              chevron={false}
              trailing={
                <View style={{ flexDirection: 'row' }}>
                  <IconButton
                    testID={`trash-restore-${i.id}`}
                    icon={RotateCcw}
                    label={t('trash.restore')}
                    onPress={() => void tr.restore(i.id)}
                  />
                  <IconButton
                    icon={Trash2}
                    tone="danger"
                    label={t('trash.deleteForever')}
                    onPress={() => setTarget(i.id)}
                  />
                </View>
              }
            />
          ))}
        </Section>
      )}
      <ConfirmDialog
        visible={target !== null}
        title={t('trash.deleteConfirmTitle')}
        message={t('trash.deleteConfirmBody')}
        confirmLabel={t('trash.deleteForever')}
        destructive
        onCancel={() => setTarget(null)}
        onConfirm={() => {
          const id = target;
          setTarget(null);
          if (id) void tr.purge(id);
        }}
      />
      <ConfirmDialog
        visible={emptyAll}
        title={t('trash.emptyConfirmTitle')}
        message={t('trash.emptyConfirmBody', { count: items.length })}
        confirmLabel={t('trash.emptyAll')}
        destructive
        onCancel={() => setEmptyAll(false)}
        onConfirm={() => {
          setEmptyAll(false);
          void tr.emptyAll();
        }}
      />
    </Screen>
  );
}
