import { useLocalSearchParams } from 'expo-router';
import { EditScreen } from '../../../../features/items/EditScreen';

export default function ItemEditRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <EditScreen id={String(id)} />;
}
