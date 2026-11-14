// CSV import from other password managers — F1 (FR-54). Port of core/src/csv-import.ts.
// Works on Unicode scalars (not Characters: "\r\n" is one Swift Character).

public enum CsvFormat: String, Sendable { case chrome, safari, bitwarden, onePassword = "1password" }

public struct CsvLoginDraft: Sendable, Equatable {
  public var title, username, password: String
  public var urls: [UrlEntry]
  public var notes: String
  public var favorite: Bool
}

public enum CsvSkipReason: String, Sendable { case noPassword = "no_password", notLogin = "not_login", fieldTooLong = "field_too_long" }

public struct CsvImportResult: Sendable {
  public var format: CsvFormat
  public var drafts: [CsvLoginDraft]
  /// 1-based line number counting the header as row 1.
  public var skipped: [(row: Int, reason: CsvSkipReason)]
}

public enum CsvImport {
  /// RFC 4180 with a leading BOM, CRLF / LF / CR, quoted fields; blank lines dropped.
  /// `E_IMPORT_FORMAT` for an unterminated quote or stray characters after a closing quote.
  public static func parse(_ input: String) throws -> [[String]] {
    var t = Array(input.unicodeScalars)
    if t.first == "\u{FEFF}" { t.removeFirst() }
    var rows: [[String]] = []
    var row: [String] = []
    var field = String.UnicodeScalarView()
    var i = 0
    let n = t.count
    func endField() { row.append(String(field)); field = String.UnicodeScalarView() }
    func endRow() {
      endField()
      if !(row.count == 1 && row[0].isEmpty) { rows.append(row) }
      row = []
    }
    while i < n {
      let c = t[i]
      if c == "\"" && field.isEmpty {
        i += 1
        while true {
          guard i < n else { throw VaultCoreError(.importFormat, "unterminated quoted field") }
          let q = t[i]
          if q == "\"" {
            if i + 1 < n && t[i + 1] == "\"" { field.append("\""); i += 2; continue }
            i += 1
            break
          }
          field.append(q)
          i += 1
        }
        if i < n && t[i] != "," && t[i] != "\n" && t[i] != "\r" {
          throw VaultCoreError(.importFormat, "unexpected character after closing quote")
        }
      } else if c == "," {
        endField()
        i += 1
      } else if c == "\r" || c == "\n" {
        if c == "\r" && i + 1 < n && t[i + 1] == "\n" { i += 1 }
        endRow()
        i += 1
      } else {
        field.append(c)
        i += 1
      }
    }
    if !field.isEmpty || !row.isEmpty { endRow() }
    return rows
  }

  public static func detectFormat(_ header: [String]) -> CsvFormat? {
    let h = header.map(\.jsTrimmed)
    let lower = Set(h.map { $0.lowercased() })
    func has(_ cols: String...) -> Bool { cols.allSatisfy(lower.contains) }
    if has("login_uri", "login_password") { return .bitwarden }
    if has("title", "url", "username", "password") {
      if h.contains("Url") { return .onePassword }
      if h.contains("URL") { return .safari }
      return lower.contains("archived") || lower.contains("tags") || lower.contains("type") ? .onePassword : .safari
    }
    if has("name", "url", "username", "password") { return .chrome }
    return nil
  }

  struct Columns { var title, url, username, password, notes, favorite, type: Int? }

  static func columns(_ f: CsvFormat, _ header: [String]) -> Columns {
    var idx: [String: Int] = [:]
    for (i, c) in header.enumerated() { idx[c.jsTrimmed.lowercased()] = i }  // last one wins, like new Map(...)
    func pick(_ names: String...) -> Int? { names.lazy.compactMap { idx[$0] }.first }
    switch f {
    case .chrome:
      return Columns(title: pick("name"), url: pick("url"), username: pick("username"), password: pick("password"), notes: pick("note", "notes"))
    case .bitwarden:
      return Columns(
        title: pick("name"), url: pick("login_uri"), username: pick("login_username"), password: pick("login_password"),
        notes: pick("notes"), favorite: pick("favorite"), type: pick("type"))
    case .safari:
      return Columns(title: pick("title"), url: pick("url"), username: pick("username"), password: pick("password"), notes: pick("notes"))
    case .onePassword:
      return Columns(
        title: pick("title"), url: pick("url"), username: pick("username"), password: pick("password"), notes: pick("notes"),
        favorite: pick("favorite"), type: pick("type"))
    }
  }

  static func toUrlEntries(_ raw: String) -> [UrlEntry] {
    var out: [UrlEntry] = []
    let parts = raw.unicodeScalars.split(whereSeparator: Crockford.isJSWhitespace).map { String(String.UnicodeScalarView($0)) }
    for part in parts where !part.isEmpty {
      let url = Matcher.schemeEnd(part) != nil ? part : "https://" + part
      let lower = url.lowercased()
      guard lower.hasPrefix("http://") || lower.hasPrefix("https://"), Matcher.hostOfStoredUrl(url) != nil else { continue }
      if out.contains(where: { $0.url == url }) { continue }
      out.append(UrlEntry(url: url, match: "domain"))
    }
    return Array(out.prefix(Field.urlsMax))
  }

  static func clipTitle(_ title: String) -> String {
    var kept = String.UnicodeScalarView()
    var used = 0
    for ch in title.unicodeScalars {
      let n = ch.value > 0xFFFF ? 2 : 1
      if used + n > Field.titleMax { break }
      kept.append(ch)
      used += n
    }
    return String(kept)
  }

  static let untitled = "（無題）"
  static let trueValues: Set<String> = ["1", "true", "yes"]

  public static func parseImport(_ text: String) throws -> CsvImportResult {
    let rows = try parse(text)
    guard let header = rows.first else { throw VaultCoreError(.importFormat, "empty file") }
    guard let format = detectFormat(header) else { throw VaultCoreError(.importFormat, "unknown CSV header") }
    let cols = columns(format, header)
    var drafts: [CsvLoginDraft] = []
    var skipped: [(row: Int, reason: CsvSkipReason)] = []
    for (k, r) in rows.dropFirst().enumerated() {
      let rowNo = k + 2
      func get(_ i: Int?) -> String { guard let i, i < r.count else { return "" }; return r[i] }
      let type = get(cols.type).jsTrimmed.lowercased()
      if cols.type != nil && !type.isEmpty && type != "login" { skipped.append((rowNo, .notLogin)); continue }
      let password = get(cols.password)
      if password.isEmpty { skipped.append((rowNo, .noPassword)); continue }
      let username = get(cols.username)
      let notes = get(cols.notes)
      if password.utf16.count > Field.passwordMax || username.utf16.count > Field.usernameMax || notes.utf16.count > Field.notesMax {
        skipped.append((rowNo, .fieldTooLong))
        continue
      }
      let urls = toUrlEntries(get(cols.url))
      let host = urls.first.flatMap { Matcher.hostOfStoredUrl($0.url) }
      let t = get(cols.title).jsTrimmed
      let title = clipTitle(!t.isEmpty ? t : (host.flatMap { $0.isEmpty ? nil : $0 } ?? (!username.isEmpty ? username : untitled)))
      drafts.append(CsvLoginDraft(
        title: title, username: username, password: password, urls: urls, notes: notes,
        favorite: trueValues.contains(get(cols.favorite).jsTrimmed.lowercased())))
    }
    return CsvImportResult(format: format, drafts: drafts, skipped: skipped)
  }

  static func domainKeys(_ psl: PublicSuffixList, _ urls: [UrlEntry]) -> Set<String> {
    var keys = Set<String>()
    for u in urls { if let h = Matcher.hostOfStoredUrl(u.url) { keys.insert(psl.registrableDomain(h) ?? h) } }
    return keys
  }

  /// Indexes of drafts that duplicate an existing login (same registrable domain or exact host,
  /// and the same user name under NFKC + lower-case).
  public static func findDuplicates(_ psl: PublicSuffixList, drafts: [CsvLoginDraft], existing: [(username: String, urls: [UrlEntry])]) -> [Int] {
    let known = existing.map { (Search.normalize($0.username), domainKeys(psl, $0.urls)) }
    var out: [Int] = []
    for (i, d) in drafts.enumerated() {
      let u = Search.normalize(d.username)
      let ds = domainKeys(psl, d.urls)
      if known.contains(where: { $0.0 == u && !$0.1.isDisjoint(with: ds) }) { out.append(i) }
    }
    return out
  }
}
