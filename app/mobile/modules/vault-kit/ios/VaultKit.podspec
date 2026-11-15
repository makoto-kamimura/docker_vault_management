Pod::Spec.new do |s|
  s.name           = 'VaultKit'
  s.version        = '0.4.0'
  s.summary        = 'うちカギ（LocalVault）の暗号・保存・同期の中核（純 Swift、拡張でも使える API のみ）'
  s.description    = 'Spec §4.3: VaultKit is shared by the app module (vault-core) and, later, the AutoFill extension.'
  s.homepage       = 'https://github.com/makoto-kamimura/docker_vault_management'
  s.license        = { :type => 'MIT' }
  s.author         = 'Makoto Kamimura'
  s.platforms      = { :ios => '17.0' }
  s.source         = { :path => '.' }
  s.swift_version  = '5.9'
  s.static_framework = true
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
  s.source_files   = 'Sources/VaultKit/**/*.swift'
  s.frameworks     = 'CryptoKit', 'Security'
end
