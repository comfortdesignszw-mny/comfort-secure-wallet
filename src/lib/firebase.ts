import { initializeApp } from 'firebase/app';
import {
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const googleAuthProvider = new GoogleAuthProvider();
googleAuthProvider.setCustomParameters({ prompt: 'select_account' });

// Pre-warm Firebase Auth config on boot so signInWithPopup executes inside the user click gesture
if (typeof window !== 'undefined') {
  void auth.authStateReady().catch(() => {
    // Ignore preload errors
  });
}

const REDIRECT_META_KEY = 'csw_google_redirect_meta_v1';

export interface GoogleRedirectMeta {
  surface: 'wallet' | 'admin';
  legalAccepted: boolean;
  requestedRole?: string;
  createdAt: number;
}

export function formatFirebaseAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code || '';
  const hostname = typeof window !== 'undefined' ? window.location.hostname : 'this domain';

  switch (code) {
    case 'auth/unauthorized-domain':
      return `Google Sign-In needs "${hostname}" added to Firebase Console → Authentication → Settings → Authorized domains. You can also sign up or sign in immediately with Email or Phone.`;
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google sign-in popup. Allow popups for this site or try again.';
    case 'auth/popup-closed-by-user':
      return 'Google account selection was closed before signing in.';
    case 'auth/cancelled-popup-request':
      return 'Previous Google sign-in window was cancelled. Please click Continue with Google once.';
    case 'auth/operation-not-allowed':
      return 'Google Sign-In is not enabled in Firebase Authentication providers yet.';
    case 'auth/network-request-failed':
      return 'Network error while reaching Google Sign-In. Check your connection and try again.';
    default:
      return err instanceof Error ? err.message : 'Google sign-in could not be completed.';
  }
}

export async function signInWithGooglePopup(options?: {
  surface?: 'wallet' | 'admin';
  legalAccepted?: boolean;
  requestedRole?: string;
}): Promise<string> {
  try {
    const credential = await signInWithPopup(auth, googleAuthProvider);
    return await credential.user.getIdToken();
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code || '';
    const isStandaloneTopWindow = typeof window !== 'undefined' && window.self === window.top;
    const shouldFallbackToRedirect =
      isStandaloneTopWindow &&
      (code === 'auth/popup-blocked' ||
        code === 'auth/operation-not-supported-in-this-environment' ||
        code === 'auth/cancelled-popup-request');

    if (shouldFallbackToRedirect) {
      try {
        const meta: GoogleRedirectMeta = {
          surface: options?.surface || 'wallet',
          legalAccepted: Boolean(options?.legalAccepted),
          requestedRole: options?.requestedRole,
          createdAt: Date.now(),
        };
        sessionStorage.setItem(REDIRECT_META_KEY, JSON.stringify(meta));
        await signInWithRedirect(auth, googleAuthProvider);
        return '__REDIRECTING__';
      } catch (redirectErr) {
        sessionStorage.removeItem(REDIRECT_META_KEY);
        throw new Error(formatFirebaseAuthError(redirectErr));
      }
    }

    throw new Error(formatFirebaseAuthError(err));
  }
}

export async function consumeGoogleRedirectResult(): Promise<{
  idToken: string;
  meta: GoogleRedirectMeta | null;
} | null> {
  try {
    const result = await getRedirectResult(auth);
    const rawMeta = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(REDIRECT_META_KEY) : null;
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(REDIRECT_META_KEY);
    }
    if (!result?.user) return null;

    let meta: GoogleRedirectMeta | null = null;
    if (rawMeta) {
      try {
        const parsed = JSON.parse(rawMeta) as GoogleRedirectMeta;
        if (Date.now() - parsed.createdAt < 10 * 60 * 1000) {
          meta = parsed;
        }
      } catch {
        meta = null;
      }
    }
    const idToken = await result.user.getIdToken();
    return { idToken, meta };
  } catch (err) {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(REDIRECT_META_KEY);
    }
    throw new Error(formatFirebaseAuthError(err));
  }
}
