// Printable emergency kit (spec §5.5). Pure: builds an HTML string with a locally generated QR.
import { formatKitQr } from '@localvault/protocol';
import { allowInsecureLocalhost } from '../../env';
import { t } from '../../i18n';
import { qrSvgString } from '../../lib/qr';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildKitHtml(kit: {
  serverUrl: string;
  accountName: string;
  recoveryKey: string;
  createdAt: Date;
}): string {
  const qr = formatKitQr(
    { serverUrl: kit.serverUrl, accountName: kit.accountName, recoveryKey: kit.recoveryKey },
    { allowInsecureLocalhost },
  );
  const d = kit.createdAt;
  const date = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  const row = (label: string, value: string, mono = false) =>
    `<tr><th>${escapeHtml(label)}</th><td${mono ? ' class="mono"' : ''}>${escapeHtml(value)}</td></tr>`;
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, "Hiragino Sans", sans-serif; color: #14151f; margin: 40px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  .sub { color: #4a4e63; margin-bottom: 24px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
  th { text-align: left; width: 28%; padding: 10px 0; color: #4a4e63; font-weight: 500; vertical-align: top; }
  td { padding: 10px 0; }
  tr { border-bottom: 1px solid #e3e5ec; }
  .mono { font-family: Menlo, monospace; font-size: 18px; letter-spacing: 1px; }
  .qr { text-align: center; margin: 24px 0; }
  .blank { border: 1.5px dashed #8a8fa3; border-radius: 8px; height: 44px; margin-top: 6px; }
  .warn { background: #fdecee; border-radius: 10px; padding: 14px 16px; color: #8c1d2a; line-height: 1.7; }
</style></head><body>
<h1>${escapeHtml(t('setup.kit.pdfTitle'))}</h1>
<div class="sub">${escapeHtml(t('common.appName'))}</div>
<table>
${row(t('setup.kit.pdfCreated'), date)}
${row(t('setup.kit.pdfServer'), kit.serverUrl)}
${row(t('setup.kit.pdfAccount'), kit.accountName)}
${row(t('setup.kit.pdfKey'), kit.recoveryKey, true)}
</table>
<div class="qr">${qrSvgString(qr, 220)}<div class="sub">${escapeHtml(t('setup.kit.pdfHowTo'))}</div></div>
<div>${escapeHtml(t('setup.kit.pdfPassword'))}<div class="blank"></div></div>
<p></p>
<div class="warn">${escapeHtml(t('setup.kit.pdfWarn1'))}<br>${escapeHtml(t('setup.kit.pdfWarn2'))}</div>
</body></html>`;
}
