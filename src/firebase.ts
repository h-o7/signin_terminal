import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export const signIn = async () => {
  try {
    console.log("[AUTH] Starting Sign-in Popup...");
    const result = await signInWithPopup(auth, googleProvider);
    console.log("[AUTH] Sign-in Success:", result.user.email);
    return result;
  } catch (error: any) {
    console.error("[AUTH] Sign-in Error Details:", {
      code: error.code,
      message: error.message,
      customData: error.customData,
      email: error.customData?.email
    });
    
    if (error.code === 'auth/popup-closed-by-user') {
      console.warn("[AUTH] Popup closed by user.");
      return null;
    }
    
    // Provide a more user-friendly alert for common Electron/Firebase issues
    if (error.code === 'auth/unauthorized-domain') {
       alert(`ERROR: Unauthorized Domain.\n\nTo fix this for Electron, you MUST add "http://localhost:4000" to your Firebase Console under Authentication > Settings > Authorized Domains.\n\nCurrent Origin: ${window.location.origin}`);
    } else {
       alert(`AUTH_ERROR: ${error.code}\n${error.message}`);
    }
    
    throw error;
  }
};
export const signOut = () => auth.signOut();
