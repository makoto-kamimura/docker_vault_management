// Creates / shares / prints the emergency kit locally (expo-print, expo-sharing). The temporary PDF
// is deleted after use (§5.5).
import { File } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { buildKitHtml } from './kitHtml';

type Kit = { serverUrl: string; accountName: string; recoveryKey: string };

function deleteQuietly(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // best effort
  }
}

export async function shareKitPdf(kit: Kit): Promise<void> {
  const { uri } = await Print.printToFileAsync({
    html: buildKitHtml({ ...kit, createdAt: new Date() }),
  });
  try {
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
    }
  } finally {
    deleteQuietly(uri);
  }
}

export async function printKit(kit: Kit): Promise<void> {
  await Print.printAsync({ html: buildKitHtml({ ...kit, createdAt: new Date() }) });
}
