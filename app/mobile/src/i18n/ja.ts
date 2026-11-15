import { jaItems } from './ja.items';
import { jaSettings } from './ja.settings';
// All user-facing strings (NFR-09). Flat, typed keys; `{name}` placeholders are interpolated by t().
export const ja = {
  // ---- common
  'common.appName': 'うちカギ',
  'common.next': '次へ',
  'common.back': '戻る',
  'common.cancel': 'キャンセル',
  'common.close': '閉じる',
  'common.ok': 'OK',
  'common.done': '完了',

  // ---- long-running key work (PBKDF2 etc.)
  'longTask.elapsed': '経過 {time}',
  'longTask.dev':
    'この開発用ビルドは暗号処理を JavaScript で行うため、鍵の計算に 1〜3 分ほどかかります。アプリを開いたままお待ちください（処理中は画面が自動で消えません）。',
  'longTask.native': '鍵を計算しています。アプリを開いたままお待ちください。',
  'common.skip': 'スキップ',
  'common.retry': '再試行',
  'common.continue': '続ける',
  'common.delete': '削除',
  'common.show': '表示',
  'common.hide': '隠す',
  'common.loading': '読み込み中',
  'common.copy': 'コピー',
  'common.share': '共有',
  'common.print': '印刷',
  'common.lock': 'ロック',
  'common.optional': '任意',

  // ---- a11y
  'a11y.revealPassword': 'パスワードを表示',
  'a11y.hidePassword': 'パスワードを隠す',
  'a11y.strength': 'パスワードの強さ: {label}',
  'a11y.lockNow': 'いまロックする',
  'a11y.toastClose': '通知を閉じる',
  'a11y.progress': '{total} 段階中 {current} 段階目',
  'a11y.qrCode': 'QR コード',
  'a11y.scanFrame': 'QR コードの読み取り枠',

  // ---- strength
  'strength.0': '未入力',
  'strength.1': '弱い',
  'strength.2': 'ふつう',
  'strength.3': '強い',
  'strength.4': 'とても強い',

  // ---- sync status
  'sync.synced': '同期済み',
  'sync.syncing': '同期中',
  'sync.offline': 'オフライン',
  'sync.error': '同期エラー',
  'sync.rollback': '巻き戻しを検知',
  'sync.lastAt': '最終同期 {time}',
  'sync.never': 'まだ同期していません',
  'sync.detailTitle': '同期の状態',
  'sync.detail.offline':
    'サーバーに接続できません。接続が戻ると自動で再試行します。保存した内容はこの端末に残っています。',
  'sync.detail.error': '同期に失敗しました。しばらくしてから自動で再試行します。',
  'sync.detail.rollback':
    'サーバーのデータが巻き戻されています。この端末のデータはそのまま保持しています。先にエクスポートしてから、サーバーの状態を受け入れるか判断してください。',
  'sync.detail.clockSkew': '端末の時刻設定を確認してください。',
  'sync.detail.needsMasterPassword': '鍵が更新されました。マスターパスワードの入力が必要です。',
  'sync.retryNow': 'いま再試行',
  'sync.acceptServer': 'サーバーの状態を受け入れる',

  // ---- errors (shared)
  'error.network': 'サーバーに接続できません。ネットワークとサーバーの URL を確認してください。',
  'error.timeout': 'サーバーの応答がありません。しばらくしてからやり直してください。',
  'error.invalidResponse':
    'サーバーの応答を読み取れませんでした。サーバーのバージョンを確認してください。',
  'error.internal': 'サーバーでエラーが発生しました。しばらくしてからやり直してください。',
  'error.rateLimited': '短時間に操作しすぎです。しばらく待ってからやり直してください。',
  'error.clockSkew': '端末の時刻設定を確認してください。',
  'error.unknown': '予期しないエラーが発生しました。',
  'error.locked': 'ロックされています。',
  'error.io': '書き込みに失敗しました。旧データは保持されています。',
  'error.corrupted': '保管庫を読み取れませんでした。',
  'error.unsupportedVersion': 'このデータは新しい形式です。アプリを更新してください。',
  'error.registrationClosed': 'このサーバーは新規登録を受け付けていません。',
  'error.accountExists': 'このアカウント名はすでに使われています。',
  'error.inviteInvalid': '招待コードが正しくないか、期限が切れています。',
  'error.wrongCredentials':
    'マスターパスワードまたはリカバリーキーが違います。入力を見直してください。',
  'error.invalidRecoveryKey': '入力に誤りがあります。リカバリーキーを確認してください。',
  'error.invalidRecoveryCode':
    '復旧コードの形式が正しくありません。読み取りか入力をやり直してください。',
  'error.rcFrozen': '復旧コードは凍結されています。リカバリーキーでの復旧をお試しください。',
  'error.claimClosed':
    'この復元要求は取り消されたか、失効しました。リカバリーキーでの復旧をお試しください。',
  'error.notFound': 'アカウントが見つかりません。',

  // ---- setup: welcome
  'setup.welcome.title': 'うちカギへようこそ',
  'setup.welcome.lead': 'あなたのサーバーだけに保存される、ゼロ知識のパスワードマネージャーです。',
  'setup.welcome.point1.title': 'サーバーは中身を読めません',
  'setup.welcome.point1.body':
    'データは端末の中で暗号化されてから送られます。サーバーの管理者にも読めません。',
  'setup.welcome.point2.title': '復旧には 2 つが必要です',
  'setup.welcome.point2.body':
    'マスターパスワードとリカバリーキーの両方を失うと、誰にも復旧できません。',
  'setup.welcome.point3.title': '第三者への通信はありません',
  'setup.welcome.point3.body':
    '解析や広告の SDK は入っていません。通信先はあなたのサーバーだけです。',
  'setup.welcome.start': 'はじめる',
  'setup.welcome.restoreCode': '復旧シートで復元',
  'setup.welcome.restoreCodeHint': '復旧コードを有効にしていた場合に使えます',

  // ---- setup: server
  'setup.server.title': 'サーバー',
  'setup.server.lead': '自分で運用しているサーバーの URL を入力してください。',
  'setup.server.urlLabel': 'サーバーの URL',
  'setup.server.urlPlaceholder': 'https://vault.example.com',
  'setup.server.check': '接続を確認',
  'setup.server.checking': '確認しています',
  'setup.server.ok': '接続できました',
  'setup.server.okDetail': 'サーバー {version}',
  'setup.server.mode.open': 'このサーバーは誰でも登録できます。',
  'setup.server.mode.invite': '登録には招待コードが必要です。',
  'setup.server.mode.closed': 'このサーバーは新規登録を受け付けていません。',
  'setup.server.createNew': '新しく作成',
  'setup.server.createNewHint': 'このサーバーに新しいアカウントを作ります',
  'setup.server.restoreExisting': '既存のアカウントで復旧・追加',
  'setup.server.restoreExistingHint': '新しいスマホにアカウントを復元します',
  'setup.server.error.invalid': 'URL の形式が正しくありません。',
  'setup.server.error.notHttps': 'https:// から始まる URL のみ使えます。',
  'setup.server.error.hasPath': 'パスや末尾の文字を除いた、ホスト名だけを入力してください。',
  'setup.server.error.hasCredentials': 'URL にユーザー名やパスワードは含められません。',

  // ---- setup: create
  'setup.create.title': 'アカウントを作成',
  'setup.create.lead':
    'マスターパスワードはこの端末の外へは送られません。忘れないものを選んでください。',
  'setup.create.invite': '招待コード',
  'setup.create.accountName': 'アカウント名',
  'setup.create.accountNameHint': '3〜32 文字。英小文字・数字・ . _ - が使えます。',
  'setup.create.password': 'マスターパスワード',
  'setup.create.passwordHint': '10 文字以上。長い文章のほうが安全です。',
  'setup.create.confirm': 'マスターパスワード（確認）',
  'setup.create.submit': 'アカウントを作成',
  'setup.create.submitting': '作成しています',
  'setup.create.step.keys': '鍵の作成',
  'setup.create.step.register': 'サーバーに登録',
  'setup.create.error.inviteRequired': '招待コードを入力してください。',
  'setup.create.error.accountTooShort': 'アカウント名は 3 文字以上にしてください。',
  'setup.create.error.accountTooLong': 'アカウント名は 32 文字以内にしてください。',
  'setup.create.error.accountChars': '使えるのは英小文字・数字・ . _ - のみです。',
  'setup.create.error.accountEdge': '先頭と末尾は英数字にしてください。',
  'setup.create.error.passwordShort': '10 文字以上にしてください。',
  'setup.create.error.mismatch': '確認用の入力が一致しません。',

  // ---- setup: recovery kit
  'setup.kit.title': '緊急キット',
  'setup.kit.lead':
    'このリカバリーキーは一度しか表示しません。紙に印刷して、安全な場所に保管してください。',
  'setup.kit.keyLabel': 'リカバリーキー',
  'setup.kit.warning':
    'この紙とマスターパスワードがあれば、誰でもデータを開けます。両方を失うと誰にも復旧できません。',
  'setup.kit.savePdf': 'PDF を保存・共有',
  'setup.kit.print': '印刷',
  'setup.kit.pdfFailed': '緊急キットを作成できませんでした。',
  'setup.kit.tailLabel': '末尾 4 文字の確認',
  'setup.kit.tailHint': '控えた紙を見ながら、リカバリーキーの末尾 4 文字を入力してください。',
  'setup.kit.tailWrong': '末尾 4 文字が一致しません。',
  'setup.kit.tailOk': '確認できました',
  'setup.kit.consent':
    'マスターパスワードとリカバリーキーの両方を失うと、誰にも復旧できないことを理解しました。',
  'setup.kit.continue': '控えました。次へ',
  'setup.kit.pdfTitle': 'うちカギ 緊急キット',
  'setup.kit.pdfCreated': '作成日',
  'setup.kit.pdfServer': 'サーバー URL',
  'setup.kit.pdfAccount': 'アカウント名',
  'setup.kit.pdfKey': 'リカバリーキー',
  'setup.kit.pdfPassword': 'マスターパスワード（書くかどうかは任意です）',
  'setup.kit.pdfWarn1': 'この紙とマスターパスワードがあれば、誰でもデータを開けます。',
  'setup.kit.pdfWarn2': '両方を失うと誰にも復旧できません。',
  'setup.kit.pdfHowTo': '新しいスマホで「復旧・追加」を選び、この QR コードを読み取ってください。',

  // ---- setup: restore
  'setup.restore.title': '復旧・追加',
  'setup.restore.lead':
    'アカウント名・マスターパスワード・リカバリーキーで、この端末に保管庫を復元します。',
  'setup.restore.recoveryKey': 'リカバリーキー',
  'setup.restore.recoveryKeyHint': '大文字小文字は区別しません。ハイフンは自動で入ります。',
  'setup.restore.scan': '緊急キットの QR を読み取る',
  'setup.restore.submit': '復元する',
  'setup.restore.submitting': '復元しています',
  'setup.restore.scanTitle': 'QR コードを読み取る',
  'setup.restore.scanBad': 'うちカギの緊急キットの QR コードではありません。',
  'setup.restore.step.verify': '確認',
  'setup.restore.step.keys': '鍵の準備',
  'setup.restore.step.sync': 'データの取得',

  // ---- setup: restore by code
  'setup.restoreCode.title': '復旧コードで復元',
  'setup.restoreCode.lead':
    '復旧シートの QR コードを読み取ってください。復元には猶予期間があり、その間に手元の端末へ通知が届きます。',
  'setup.restoreCode.scan': '復旧シートの QR を読み取る',
  'setup.restoreCode.manual': '読み取れない場合は手入力',
  'setup.restoreCode.serverUrl': 'サーバーの URL',
  'setup.restoreCode.accountName': 'アカウント名',
  'setup.restoreCode.text': '復旧コード',
  'setup.restoreCode.textHint': 'LVRC-から始まる文字列',
  'setup.restoreCode.submit': '復元を開始',
  'setup.restoreCode.submitting': '要求を送っています',
  'setup.restoreCode.scanBad': 'うちカギの復旧シートの QR コードではありません。',

  // ---- setup: restore wait
  'setup.wait.title': '復元の待機中',
  'setup.wait.lead':
    '猶予期間が終わると、自動で復元が始まります。アプリを閉じても、この画面から再開できます。',
  'setup.wait.remaining': '残り時間',
  'setup.wait.ready': '猶予期間が終わりました',
  'setup.wait.hint': '手元にスマホがあれば、「自分で使った」を選ぶとすぐ完了します。',
  'setup.wait.checking': '状態を確認しています',
  'setup.wait.abort': '復元を中止',
  'setup.wait.abortConfirmTitle': '復元を中止しますか',
  'setup.wait.abortConfirmBody':
    '要求はこの端末から取り下げられます。必要ならもう一度やり直せます。',
  'setup.wait.completing': '復元しています',

  // ---- setup: new password
  'setup.newPassword.title': '新しいマスターパスワード',
  'setup.newPassword.lead':
    '復旧コードで復元できました。続けて、新しいマスターパスワードを設定してください。この手順は省略できません。',
  'setup.newPassword.submit': '設定する',
  'setup.newPassword.submitting': '設定しています',
  'setup.newPassword.next': '次に、新しい緊急キットを作成します。',

  // ---- setup: biometrics
  'setup.bio.title': '生体認証',
  'setup.bio.lead': '{kind}で素早くロックを解除できます。マスターパスワードはいつでも使えます。',
  'setup.bio.kind.faceId': 'Face ID',
  'setup.bio.kind.touchId': 'Touch ID',
  'setup.bio.kind.biometric': '生体認証',
  'setup.bio.enable': '{kind}を有効にする',
  'setup.bio.unavailable':
    'この端末では生体認証を使えません。マスターパスワードのみで利用できます。',
  'setup.bio.enabled': '有効にしました',
  'setup.bio.failed': '有効にできませんでした。あとから設定で変更できます。',

  // ---- setup: notifications
  'setup.notif.title': '通知',
  'setup.notif.lead':
    'PC からの解錠リクエストや、復元要求の知らせを受け取るために通知を許可してください。',
  'setup.notif.enable': '通知を許可',
  'setup.notif.denied': '通知は許可されていません。アプリを開けばリクエストを確認できます。',
  'setup.notif.granted': '通知を許可しました',
  'setup.notif.note': '通知の内容は固定の文言で、パスワードや端末名は含まれません。',

  // ---- setup: autofill
  'setup.autofill.title': 'オートフィル',
  'setup.autofill.lead':
    '他のアプリやブラウザのログイン画面で、保存した情報を入力できるようにします。',
  'setup.autofill.status.on': '有効',
  'setup.autofill.status.off': '未設定',
  'setup.autofill.status.unsupported': 'この端末は未対応です',
  'setup.autofill.enable': '設定を開く',
  'setup.autofill.ios.step1': '設定アプリを開く',
  'setup.autofill.ios.step2': '「一般」→「自動入力とパスワード」を選ぶ',
  'setup.autofill.ios.step3': '「自動入力」をオンにし、うちカギにチェックを入れる',
  'setup.autofill.android.step1': '設定アプリで「パスワードとアカウント」を開く',
  'setup.autofill.android.step2': '「自動入力サービス」でうちカギを選ぶ',
  'setup.autofill.android.step3':
    'Chrome の設定 →「自動入力サービス」→「他のサービスを使用」をオンにする',
  'setup.autofill.finish': '完了',
  'setup.autofill.later': 'あとで設定する',

  // ---- unlock
  'unlock.title': 'ロック中',
  'unlock.lead': 'うちカギを開くには、ロックを解除してください。',
  'unlock.password': 'マスターパスワード',
  'unlock.submit': 'ロックを解除',
  'unlock.biometric': '{kind}で解除',
  'unlock.usePassword': 'マスターパスワードで解除',
  'unlock.forgot': 'マスターパスワードを忘れた',
  'unlock.wrong': 'パスワードが違います。',
  'unlock.attemptsLeft': 'あと {n} 回で待機時間が入ります。',
  'unlock.throttled': '{sec} 秒後にもう一度お試しください。',
  'unlock.throttledMin': 'あと {min} 分 {sec} 秒お待ちください。',
  'unlock.bioInvalidated':
    '生体情報が変更されました。マスターパスワードで解除したあと、設定から生体認証を再設定してください。',
  'unlock.bioFailed': '生体認証に失敗しました。マスターパスワードを入力してください。',
  'unlock.forgotTitle': 'マスターパスワードを忘れたとき',
  'unlock.forgotBody':
    '生体認証でロックを解除できる端末があれば、解除したうえで「設定 → アカウント」からリカバリーキーを使って新しいマスターパスワードを設定できます。\n\n生体認証でも解除できず、復旧コードも有効にしていない場合は、復旧できません。',
  'unlock.forgotBio': '生体認証で解除する',

  // ---- revoked / deleted
  'revoked.title': 'この端末は解除されました',
  'revoked.lead': '別の端末から、この端末の登録が解除されました。同期は停止し、ロックしています。',
  'revoked.wipe': '端末内のデータを消去',
  'revoked.reregister': 'もう一度登録する',
  'revoked.wipeConfirmTitle': '端末内のデータを消去しますか',
  'revoked.wipeConfirmBody':
    'この端末に保存された保管庫を消去します。サーバー上のデータには影響しません。',
  'revoked.reregisterHint':
    'リカバリーキーを使って、この端末をあらためて登録します（端末内のデータは先に消去されます）。',
  'deleted.title': 'アカウントが削除されました',
  'deleted.lead':
    '別の端末でこのアカウントが削除されました。この端末内のデータを消去して、最初の画面に戻ります。',
  'deleted.wipe': 'データを消去して最初に戻る',

  // ---- list placeholder
  'home.title': 'パスワード',
  'home.empty.title': 'まだ項目がありません',
  'home.empty.body': '項目の追加と編集は、次のバージョンで使えるようになります。',
  'home.lock': 'ロック',

  // ---- QR scanner
  'qr.permission.title': 'カメラの許可が必要です',
  'qr.permission.body':
    'QR コードを読み取るために、カメラの使用を許可してください。映像は端末の外へ送られません。',
  'qr.permission.allow': 'カメラを許可',
  'qr.permission.settings': '設定を開く',
  'qr.permission.denied': 'カメラが許可されていません。設定アプリから許可してください。',
  'qr.hint': '枠の中に QR コードを合わせてください',
  'qr.loading': 'カメラを準備しています',
  ...jaItems,
  ...jaSettings,
} as const;

export type MessageKey = keyof typeof ja;
