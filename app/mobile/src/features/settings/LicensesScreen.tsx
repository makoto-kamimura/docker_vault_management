import { Card, ListRow, Screen, Section, Text } from '../../components';
import { t } from '../../i18n';
import { nav } from '../../lib/nav';
import { LICENSES } from './licenses.generated';

export function LicensesScreen() {
  return (
    <Screen title={t('lic.title')} subtitle={t('lic.lead')} onBack={nav.back}>
      <Card>
        <Text variant="callout" weight="semibold">
          {t('lic.pslTitle')}
        </Text>
        <Text variant="footnote" tone="secondary">
          {t('lic.pslBody')}
        </Text>
      </Card>
      <Section title={t('lic.packages')}>
        {LICENSES.map((l) => (
          <ListRow
            key={l.name}
            title={l.name}
            subtitle={`${l.version} ・ ${l.license}`}
            chevron={false}
          />
        ))}
      </Section>
    </Screen>
  );
}
