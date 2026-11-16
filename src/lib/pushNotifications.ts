import { NotificationChannel, NotificationRecord } from '../shared/types.ts';
import { apiFetch } from './api.ts';

const SEEN_PUSH_KEY = 'csw_seen_push_ids_v1';

function getSeenIds(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(SEEN_PUSH_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveSeenIds(ids: Set<string>) {
  try {
    window.sessionStorage.setItem(SEEN_PUSH_KEY, JSON.stringify([...ids].slice(-100)));
  } catch {
    // ignore
  }
}

export async function ensurePushSubscription(): Promise<{ permission: string; subscribed: boolean }> {
  let permission: string = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    try {
      permission = await Notification.requestPermission();
    } catch {
      permission = Notification.permission;
    }
  }

  let endpoint = `https://push.comfortwallet.zw/pwa/${Date.now()}`;
  let keys: Record<string, string> = { p256dh: 'pwa_client_push', auth: 'pwa_auth_push' };

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const existingSub = await reg.pushManager?.getSubscription();
      if (existingSub) {
        endpoint = existingSub.endpoint;
        const json = existingSub.toJSON();
        if (json.keys) keys = json.keys;
      }
    } catch {
      // Service worker push manager optional in sandboxed preview
    }
  }

  try {
    await apiFetch('/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint, keys }),
    });
    return { permission, subscribed: true };
  } catch {
    return { permission, subscribed: false };
  }
}

export async function dispatchTransactionPushAlerts(notifications: NotificationRecord[]) {
  if (typeof window === 'undefined' || notifications.length === 0) return;

  const seen = getSeenIds();
  const isFirstHydration = seen.size === 0;
  const pushAlerts = notifications.filter((n) => n.channel === NotificationChannel.PUSH);

  if (isFirstHydration) {
    // Seed existing alerts on initial load so historical notifications don't replay repeatedly
    for (const item of pushAlerts) {
      seen.add(item.id);
    }
    saveSeenIds(seen);
    return;
  }

  const unseen = pushAlerts.filter((n) => !seen.has(n.id));
  if (unseen.length === 0) return;

  for (const item of unseen) {
    seen.add(item.id);
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
          const reg = await navigator.serviceWorker.ready;
          await reg.showNotification(item.title, {
            body: item.body,
            icon: '/pwa-192x192.png',
            tag: item.id,
          });
        } else {
          new Notification(item.title, { body: item.body, tag: item.id });
        }
      } catch {
        // Ignore browser notification error inside restricted iframes
      }
    }
  }
  saveSeenIds(seen);
}
