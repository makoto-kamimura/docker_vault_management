import { useLocalSearchParams } from 'expo-router';
import { DetailScreen } from '../../../../features/items/DetailScreen';

export default function ItemDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DetailScreen id={String(id)} />;
}
