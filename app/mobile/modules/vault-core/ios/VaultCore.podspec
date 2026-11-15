Pod::Spec.new do |s|
  s.name           = 'VaultCore'
  s.version        = '0.4.0'
  s.summary        = 'うちカギ native VaultCore (Expo module "LocalVaultCore")'
  s.description    = 'Bridges VaultKit to JS and provides the iOS parts: Keychain, Face ID, clipboard, files, lifecycle.'
  s.homepage       = 'https://github.com/makoto-kamimura/docker_vault_management'
  s.license        = { :type => 'MIT' }
  s.author         = 'Makoto Kamimura'
  s.platforms      = { :ios => '17.0' }
  s.source         = { :path => '.' }
  s.swift_version  = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'VaultKit'
  s.frameworks     = 'LocalAuthentication', 'Security', 'UIKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
  s.source_files   = '*.swift'
end
