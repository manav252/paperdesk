import type { Socket } from 'socket.io-client';
import { apiUrl, projectOwnerId } from './lib/api';
import { currentAccessToken, currentAccount, onAccountChange } from './lib/auth';

let socket: Promise<Socket> | null = null;

/**
 * The app's connection for chat messages and notifications, opened the first time it is needed. It signs in again
 * when the account changes. (Co-editing keeps its own connection, which lives only while a shared project is open.)
 */
export function live() {
  socket ??= import('socket.io-client').then(({ io }) => {
    const s = io(apiUrl('/').replace(/\/$/, '') || undefined, {
      auth: (cb) => {
        const token = currentAccessToken();
        cb(token ? { token } : { owner: projectOwnerId() });
      },
    });
    let who = currentAccount()?.id;
    onAccountChange((account) => {
      if (account?.id === who) return;
      who = account?.id;
      s.disconnect().connect();
    });
    return s;
  });
  return socket;
}
