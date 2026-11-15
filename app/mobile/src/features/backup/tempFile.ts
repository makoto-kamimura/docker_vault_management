import { File } from 'expo-file-system';

/** Deletes our cache copy of a picked/exported file (best effort). */
export function deleteTempFile(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // best effort
  }
}
