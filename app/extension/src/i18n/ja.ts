// All user-facing strings (Japanese). Code and comments stay English.
export const ja = {
  appName: 'LocalVault',
  common: {
    cancel: 'キャンセル',
    close: '閉じる',
    back: '戻る',
    retry: '再試行',
    loading: '読み込み中…',
    copied: 'コピーしました',
    seconds: (n: number) => `${n} 秒`,
  },
  popup: {
    lockedTitle: 'ロック中',
    unlockedTitle: '解錠中',
    unlockButton: 'スマホで解錠',
    lockButton: 'ロックする',
    waitingTitle: 'スマホで番号を入力してください',
    waitingHelp: 'スマホに通知が届きます。この番号をスマホに入力し、生体認証で承認してください。',
    codeLabel: '確認番号',
    remaining: (s: number) => `残り ${s} 秒`,
    cancelRequest: 'リクエストを取り消す',
    denied: 'スマホで拒否されました',
    expired: 'リクエストの有効期限が切れました。もう一度お試しください',
    failedBadVk: '承認の内容を確認できませんでした。もう一度お試しください',
    failedOther: '解錠できませんでした。もう一度お試しください',
    searchPlaceholder: '項目を検索',
    searchLabel: '項目を検索',
    thisSite: 'このサイトの候補',
    allItems: 'すべての項目',
    noItems: '項目がありません',
    noMatches: '一致する項目がありません',
    copyUsername: 'ユーザー名をコピー',
    copyPassword: 'パスワードをコピー',
    copyUsernameFor: (t: string) => `${t} のユーザー名をコピー`,
    copyPasswordFor: (t: string) => `${t} のパスワードをコピー`,
    clipboardClears: (s: number) => `${s} 秒後にクリップボードを消去します`,
    clipboardKeeps: 'クリップボードは自動では消去されません',
    notPaired: 'この PC はまだ登録されていません',
    openOptions: '設定を開く',
    sessionEnds: (t: string) => `${t} までロックされません`,
    sessionSingle: 'この解錠は 1 回の入力・コピーで終了します',
    syncedAt: (t: string) => `最終同期 ${t}`,
    syncNow: '今すぐ同期',
    skipped: (n: number) => `${n} 件の項目を読み取れませんでした`,
  },
  warnings: {
    rollbackTitle: 'サーバーのデータが巻き戻されています',
    rollbackBody:
      'サーバーの内容が以前より古くなっています。同期を停止し、この PC 内のデータはそのまま残しています。サーバーの管理者に確認してください。',
    acceptServer: 'サーバーの状態を受け入れる',
    acceptConfirm:
      'サーバーの内容で置き換えます。古いデータに戻っている可能性があります。続けますか？',
    revoked: 'この PC は登録解除されました。もう一度ペアリングしてください。',
    accountDeleted: 'アカウントが削除されました。この PC のデータを消去しました。',
    unpaired: 'ペアリングを解除しました。',
    clockSkew: 'PC の時刻設定を確認してください',
    network: 'サーバーに接続できません。しばらくしてからもう一度お試しください',
    internal: 'サーバーで問題が発生しました。もう一度お試しください',
    rateLimited: 'リクエストが多すぎます。しばらく待ってからお試しください',
    generic: '処理できませんでした',
  },
  options: {
    title: 'LocalVault の設定',
    serverSection: 'サーバー',
    serverLabel: 'サーバー URL',
    serverHelp: 'https:// から始まる URL を入力します。この URL だけと通信します。',
    serverInvalid: 'URL を確認してください（https:// のみ、パスなし）',
    pairingSection: 'ペアリング',
    pairingStart: 'ペアリングを開始',
    pairingHelp:
      'スマホの LocalVault で「PC を追加」を選び、下の QR コードを読み取ってください。承認すると、この PC はすぐに解錠されます。',
    pairingQrLabel: 'ペアリング用の QR コード',
    pairingExpires: (s: number) => `有効期限 残り ${s} 秒`,
    pairingExpired: 'QR コードの有効期限が切れました。もう一度開始してください',
    pairingFailed: 'ペアリングを完了できませんでした。もう一度お試しください',
    pairingDone: 'ペアリングが完了しました',
    permissionDenied: 'サーバーへのアクセス許可が必要です',
    pairedAs: (name: string) => `この PC は「${name}」として登録されています`,
    unpair: 'ペアリングを解除',
    unpairConfirm:
      'この PC のデータと端末鍵を削除します。スマホ側の端末一覧からも、この PC を削除してください。',
    clipboardSection: 'クリップボード',
    clipboardLabel: 'コピーしたパスワードを消去するまでの時間',
    clipboardChoices: { '30': '30 秒', '60': '60 秒', '120': '2 分', never: '消去しない' },
    clipboardNote:
      '消去は、他の内容をコピーした後でも設定時間が来ると実行されます（クリップボードの読み取りは行いません）。',
    aboutSection: 'このブラウザ拡張について',
    aboutBody:
      'パスワードはこの PC のメモリ上でだけ復号され、ディスクには保存されません。ロックは、設定した時間、PC の無操作 15 分、画面ロック、ブラウザの終了で行われます。',
  },
  content: {
    iconLabel: 'LocalVault で入力',
    panelLabel: 'LocalVault',
    candidatesTitle: '候補',
    frameTitle: (domain: string) => `${domain} のフォーム`,
    noCandidates: 'このサイトに一致する項目がありません',
    unlockPrompt: 'LocalVault はロックされています',
    unlockButton: 'スマホで解錠',
    notPaired: 'LocalVault が未設定です。拡張の設定からペアリングしてください',
    waitingTitle: 'スマホで番号を入力してください',
    codeLabel: '確認番号',
    cancel: 'キャンセル',
    unlockDone: '解錠しました',
    unlockFailed: '解錠できませんでした',
    insecureTitle: 'このページは暗号化されていません（http）',
    insecureBody:
      '通信内容が第三者に見られる可能性があります。パスワードを入力するのは、信頼できる場合だけにしてください。',
    insecureContinue: '承知して項目を選ぶ',
    searchPlaceholder: '項目を検索',
    fillFailed: '入力できませんでした',
    fieldHidden: '見えない入力欄には入力しません',
    close: '閉じる',
  },
  errors: {
    E_LOCKED: 'ロックされています',
    E_NOT_PAIRED: 'ペアリングされていません',
    E_FORBIDDEN_ORIGIN: 'このページには入力できません',
    E_INSECURE_PAGE: 'http のページでは確認が必要です',
    E_NOT_FOUND: '項目が見つかりません',
    E_DEVICE_REVOKED: 'この PC は登録解除されました',
    E_ACCOUNT_DELETED: 'アカウントが削除されました',
    E_BAD_SERVER_URL: 'サーバー URL が正しくありません',
  } as Record<string, string>,
};

/** Maps a worker error to a short Japanese message. */
export function errorMessage(error: { code: string } | undefined): string {
  if (error === undefined) return ja.warnings.generic;
  switch (error.code) {
    case 'E_CLOCK_SKEW':
      return ja.warnings.clockSkew;
    case 'E_NETWORK':
      return ja.warnings.network;
    case 'E_INTERNAL':
      return ja.warnings.internal;
    case 'E_RATE_LIMITED':
      return ja.warnings.rateLimited;
    default:
      return ja.errors[error.code] ?? ja.warnings.generic;
  }
}
