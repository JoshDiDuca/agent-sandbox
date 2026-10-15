// The OpenVPN download entry (shared: the sandbox installs it, doctor checks that its host is reachable).
/** The release page lists no checksums: these were computed from the files on swupdate.openvpn.org (https). */
export const OPENVPN_MSI = {
  version: '2.7.8',
  x64: {
    file: 'OpenVPN-2.7.8-I001-amd64.msi',
    sha256: '1ea61a3056905b90607d4b0f084c04e5cf3043e07cf192d9cd44b0474f29cc49',
  },
  arm64: {
    file: 'OpenVPN-2.7.8-I001-arm64.msi',
    sha256: '6fc0e8899cc5275ee297fb837bc84aa2bc49f8ef96d7ad93ee3fee1e7163a25c',
  },
  base: 'https://swupdate.openvpn.org/community/releases/',
} as const;

/**
 * WireGuard for Windows (brings wireguard.exe and wg.exe). Hashes computed from the files on download.wireguard.com
 * (https); both files carry a valid WireGuard LLC signature.
 */
export const WIREGUARD_MSI = {
  version: '1.1.1',
  x64: {
    file: 'wireguard-amd64-1.1.1.msi',
    sha256: '7bfed60ad61b785c914b38b61555a975488e1d3ec472dbfb2fcdf498fca75242',
  },
  arm64: {
    file: 'wireguard-arm64-1.1.1.msi',
    sha256: '8336335c738d4aff040fa9d11b752da65a80b6f41d3262d6ba5e82f97ebd1bd4',
  },
  base: 'https://download.wireguard.com/windows-client/',
} as const;
