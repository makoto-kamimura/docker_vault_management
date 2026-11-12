// Local list preferences (sort mode) in a small JSON file in the app's document directory.
// A failure is never fatal: the default is used.
import { File, Paths } from 'expo-file-system';
import type { SortMode } from './model';

const file = () => new File(Paths.document, 'lv-list-prefs.json');

export async function loadSortMode(): Promise<SortMode> {
  try {
    const f = file();
    if (!f.exists) return 'recent';
    const v = (JSON.parse(await f.text()) as { sort?: unknown }).sort;
    return v === 'name' ? 'name' : 'recent';
  } catch {
    return 'recent';
  }
}

export async function saveSortMode(sort: SortMode): Promise<void> {
  try {
    const f = file();
    f.create({ overwrite: true });
    await f.write(JSON.stringify({ sort }));
  } catch {
    // ignore
  }
}
