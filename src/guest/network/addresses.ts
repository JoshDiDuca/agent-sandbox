import os from 'node:os';

/** Guest IPv4 addresses the host can use to reach session ports. */
export const guestAddresses = (): string[] =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => Boolean(i) && i!.family === 'IPv4' && !i!.internal)
    .map((i) => i.address);
