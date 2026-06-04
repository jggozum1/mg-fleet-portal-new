import { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { collection, doc, getDoc, getDocs, limit, query, where } from 'firebase/firestore'
import { auth, db, isFirebaseConfigured } from '../lib/firebase'
import { promotePendingToUser } from '../lib/users'
import { isSessionVerified, clearSessionVerified } from '../lib/otp'

const AuthContext = createContext(null)

async function loadUserProfile(fbUser) {
  // 1. users/{authUid}
  const direct = await getDoc(doc(db, 'users', fbUser.uid))
  if (direct.exists()) {
    return { id: direct.id, _matchedBy: 'uid-as-docid', ...direct.data() }
  }

  // 2. users where uid == authUid
  const byUid = await getDocs(
    query(collection(db, 'users'), where('uid', '==', fbUser.uid), limit(1)),
  )
  if (!byUid.empty) {
    const d = byUid.docs[0]
    return { id: d.id, _matchedBy: 'uid-field', ...d.data() }
  }

  // 3. users where email == authEmail
  if (fbUser.email) {
    const byEmail = await getDocs(
      query(collection(db, 'users'), where('email', '==', fbUser.email), limit(1)),
    )
    if (!byEmail.empty) {
      const d = byEmail.docs[0]
      return { id: d.id, _matchedBy: 'email-field', ...d.data() }
    }

    // 4. users where user_name == authEmail (legacy schema stores username here)
    const byUserName = await getDocs(
      query(collection(db, 'users'), where('user_name', '==', fbUser.email), limit(1)),
    )
    if (!byUserName.empty) {
      const d = byUserName.docs[0]
      return { id: d.id, _matchedBy: 'user_name-field', ...d.data() }
    }
  }

  return null
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [profileError, setProfileError] = useState(null)
  const [loading, setLoading] = useState(isFirebaseConfigured)
  const [otpVerified, setOtpVerified] = useState(isSessionVerified)

  useEffect(() => {
    if (!isFirebaseConfigured) return
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      setUser(fbUser)
      setProfileError(null)
      if (fbUser) {
        try {
          let p = await loadUserProfile(fbUser)
          // If no user doc exists, check for a pending invite and promote it
          if (!p && fbUser.email) {
            console.log('[auth] no user doc — checking pending invite for', fbUser.email)
            await promotePendingToUser(fbUser.uid, fbUser.email)
            p = await loadUserProfile(fbUser)
          }
          setProfile(p)
          if (p) {
            console.log('[auth] profile loaded via', p._matchedBy, '→', p)
          } else {
            console.warn('[auth] no matching users doc for uid', fbUser.uid, 'email', fbUser.email)
          }
        } catch (err) {
          console.error('[auth] profile lookup failed:', err)
          setProfileError(err)
          setProfile(null)
        }
      } else {
        setProfile(null)
      }
      setLoading(false)
    })
    return unsub
  }, [])

  const login = (email, password) => {
    if (!isFirebaseConfigured) {
      return Promise.reject(new Error('Firebase is not configured. Create .env.local first.'))
    }
    return signInWithEmailAndPassword(auth, email, password)
  }
  const logout = () => {
    clearSessionVerified()
    setOtpVerified(false)
    return isFirebaseConfigured ? signOut(auth) : Promise.resolve()
  }

  return (
    <AuthContext.Provider
      value={{ user, profile, profileError, loading, login, logout, isFirebaseConfigured, otpVerified, setOtpVerified }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
