import type { RecoverySheet } from '@localvault/core';
import { t } from '../../i18n';
import { formatDate } from '../../lib/format';
import { qrSvgString } from '../../lib/qr';
import { escapeHtml } from '../setup/kitHtml';

/** Printable recovery sheet (§8.11.2); the QR is generated on the device. */
export function buildSheetHtml(p: {
  sheet: RecoverySheet;
  serverUrl: string;
  accountName: string;
  waitHours: number;
  createdAt: Date;
}): string {
  const row = (l: string, v: string, mono = false) =>
    `<tr><th>${escapeHtml(l)}</th><td${mono ? ' class="mono"' : ''}>${escapeHtml(v)}</td></tr>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
body{font-family:-apple-system,"Hiragino Sans",sans-serif;color:#14151f;margin:40px}
h1{font-size:26px;margin:0 0 12px}table{border-collapse:collapse;width:100%;margin-bottom:16px}
th{text-align:left;width:28%;padding:8px 0;color:#4a4e63;font-weight:500;vertical-align:top}td{padding:8px 0}
tr{border-bottom:1px solid #e3e5ec}.mono{font-family:Menlo,monospace;font-size:15px;letter-spacing:1px;word-break:break-all}
.qr{text-align:center;margin:20px 0}.warn{background:#fdecee;border-radius:10px;padding:14px 16px;color:#8c1d2a;line-height:1.7}
</style></head><body>
<h1>${escapeHtml(t('rc.pdf.title'))}</h1>
<div class="warn">${escapeHtml(t('rc.pdf.warn'))}</div>
<table>${row(t('setup.kit.pdfCreated'), formatDate(p.createdAt.toISOString()))}${row(t('setup.kit.pdfServer'), p.serverUrl)}${row(t('setup.kit.pdfAccount'), p.accountName)}${row(t('rc.pdf.wait'), t('rc.pdf.waitHours', { h: p.waitHours }))}${row(t('rc.pdf.text'), p.sheet.text, true)}</table>
<div class="qr">${qrSvgString(p.sheet.qr, 240)}</div>
<p>${escapeHtml(t('rc.pdf.keep'))}</p></body></html>`;
}
