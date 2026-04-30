"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import {
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile
} from "firebase/auth";
import { app } from "@/lib/firebase";
import { createUser, getUser, updateUser } from "@/lib/api";

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user,        setUser]        = useState(null);
  const [profileData, setProfileData] = useState(null);
  const [loading,     setLoading]     = useState(true);
  const auth = getAuth(app);

  // ── Fetch/refresh profile from MongoDB ───────────────
  const refreshProfile = useCallback(async (uid) => {
    try {
      const profile = await getUser(uid);
      setProfileData(profile);
    } catch {
      setProfileData(null);
    }
  }, []);

  // ── After Firebase auth → upsert user in MongoDB ─────
  const syncUserToMongo = useCallback(async (firebaseUser) => {
    try {
      await createUser({
        uid:      firebaseUser.uid,
        name:     firebaseUser.displayName || "New User",
        email:    firebaseUser.email,
        photoURL: firebaseUser.photoURL ||
          `https://ui-avatars.com/api/?name=${encodeURIComponent(firebaseUser.email)}&background=random`,
      });
      await refreshProfile(firebaseUser.uid);
    } catch (err) {
      console.error("syncUserToMongo failed:", err);
    }
  }, [refreshProfile]);

  // ── Auth state listener ───────────────────────────────
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        await syncUserToMongo(firebaseUser);
      } else {
        setProfileData(null);
        setLoading(false);
      }
      setLoading(false);
    });
    return unsub;
  }, [auth, syncUserToMongo]);

  // ── Auth methods (Firebase only) ──────────────────────
  const loginWithGoogle = async () => {
    const provider = new GoogleAuthProvider();
    try {
      const result = await signInWithPopup(auth, provider);
      await syncUserToMongo(result.user);
    } catch (error) {
      console.error("Google login failed:", error);
      throw error;
    }
  };

  const registerWithEmail = async (email, password, name) => {
    try {
      const result = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(result.user, { displayName: name });
      await syncUserToMongo({ ...result.user, displayName: name });
    } catch (error) {
      console.error("Registration failed:", error);
      throw error;
    }
  };

  const loginWithEmail = async (email, password) => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      throw error; // handled in page.js with user-friendly messages
    }
  };

  const logout = async () => {
    if (user) {
      await updateUser(user.uid, { status: "offline", lastSeen: new Date().toISOString() }).catch(() => {});
    }
    signOut(auth);
  };

  return (
    <AuthContext.Provider value={{
      user,
      profileData,
      loading,
      loginWithGoogle,
      registerWithEmail,
      loginWithEmail,
      logout,
      refreshProfile,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
