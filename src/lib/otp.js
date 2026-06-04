// 2FA OTP helpers — generate, send (Firebase Trigger Email), store/verify (Firestore).

import { addDoc, collection, deleteDoc, doc, getDoc, serverTimestamp, setDoc, updateDoc, increment } from 'firebase/firestore'
import { db } from './firebase'

export const OTP_ENABLED = import.meta.env.VITE_OTP_ENABLED === 'true'

const OTP_COLLECTION = 'otpCodes'
const MAIL_COLLECTION = 'mail'
const SESSION_KEY = 'mgfp:2fa-verified'
const OTP_EXPIRY_MS = 5 * 60 * 1000 // 5 minutes
const MAX_ATTEMPTS = 5

export function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

export async function sendOtp(email, code, userName) {
  if (!db) throw new Error('Firestore not configured.')
  // Write to the `mail` collection — the Firebase "Trigger Email" extension
  // picks it up and sends via the configured SMTP (mg.fleetsystem@gmail.com).
  await addDoc(collection(db, MAIL_COLLECTION), {
    to: email,
    message: {
      subject: 'MG Fleet Portal — Your Login Code',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#1a1a2e;border-radius:16px;overflow:hidden">
          <div style="text-align:center;padding:32px 24px 16px">
            <img src="https://mgfleetsystem.com/MG-Fleet-logo.PNG" alt="MG Fleet" style="width:120px;height:auto;object-fit:contain" />
            <h2 style="margin:12px 0 0;color:#ffffff;font-size:18px;letter-spacing:2px">MG FLEET PORTAL</h2>
            <p style="color:#888;font-size:13px;margin:4px 0 0">One-Time Verification Code</p>
          </div>
          <div style="margin:16px 24px;background:#2a2a3e;border-radius:12px;padding:24px;text-align:center">
            <div style="font-size:36px;font-weight:900;letter-spacing:10px;color:#ef4444">${code}</div>
            <p style="color:#888;font-size:13px;margin-top:12px">This code expires in 5 minutes.</p>
          </div>
          <p style="color:#555;font-size:11px;text-align:center;padding:8px 24px 24px">
            If you did not request this code, please ignore this email.
          </p>
        </div>
      `,
    },
  })
}

export async function storeOtp(uid, email, code) {
  if (!db) throw new Error('Firestore not configured.')
  await setDoc(doc(db, OTP_COLLECTION, uid), {
    code,
    email,
    createdAt: serverTimestamp(),
    expiresAt: Date.now() + OTP_EXPIRY_MS,
    attempts: 0,
  })
}

export async function verifyOtp(uid, inputCode) {
  if (!db) throw new Error('Firestore not configured.')
  const ref = doc(db, OTP_COLLECTION, uid)
  const snap = await getDoc(ref)
  if (!snap.exists()) return { ok: false, reason: 'No OTP found. Please request a new code.' }

  const data = snap.data()

  if (Date.now() > data.expiresAt) {
    await deleteDoc(ref)
    return { ok: false, reason: 'Code expired. Please request a new code.' }
  }

  if (data.attempts >= MAX_ATTEMPTS) {
    await deleteDoc(ref)
    return { ok: false, reason: 'Too many failed attempts. Please sign in again.', forceSignOut: true }
  }

  if (String(inputCode).trim() !== String(data.code)) {
    await updateDoc(ref, { attempts: increment(1) })
    const remaining = MAX_ATTEMPTS - data.attempts - 1
    return { ok: false, reason: `Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` }
  }

  await deleteDoc(ref)
  return { ok: true }
}

export async function clearOtp(uid) {
  if (!db || !uid) return
  try { await deleteDoc(doc(db, OTP_COLLECTION, uid)) } catch {}
}

export function isSessionVerified() {
  try { return sessionStorage.getItem(SESSION_KEY) === 'true' } catch { return false }
}

export function markSessionVerified() {
  try { sessionStorage.setItem(SESSION_KEY, 'true') } catch {}
}

export function clearSessionVerified() {
  try { sessionStorage.removeItem(SESSION_KEY) } catch {}
}
