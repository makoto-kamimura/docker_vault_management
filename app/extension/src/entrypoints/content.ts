import { defineContentScript } from 'wxt/utils/define-content-script';
import { startContent } from '../content/main';

export default defineContentScript({
  matches: ['https://*/*', 'http://*/*'],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    startContent();
  },
});
