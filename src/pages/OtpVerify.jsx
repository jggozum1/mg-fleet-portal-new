import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { defaultRouteForRole } from '../lib/roles'
import {
  generateOtp, sendOtp, storeOtp, verifyOtp,
  markSessionVerified, isSessionVerified,
} from '../lib/otp'

export default function OtpVerify() {
  const { user, profile, logout, setOtpVerified } = useAuth()
  const navigate = useNavigate()
  const [digits, setDigits] = useState(['', '', '', '', '', ''])
  const [error, setError] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(0)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const sentOnce = useRef(false)
  const inputRefs = useRef([])

  // Redirect if already verified or not logged in
  useEffect(() => {
    if (!user) { navigate('/login', { replace: true }); return }
    if (isSessionVerified()) {
      setOtpVerified(true)
      const dest = profile ? defaultRouteForRole(profile.role) : '/home'
      navigate(dest, { replace: true })
    }
  }, [user, profile, navigate, setOtpVerified])

  // Cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return
    const t = setTimeout(() => setResendCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [resendCooldown])

  const email = user?.email || ''
  const maskedEmail = email
    ? email.replace(/(.{2})(.*)(@.*)/, (_, a, b, c) => a + '*'.repeat(b.length) + c)
    : ''

  const handleResend = async () => {
    if (resendCooldown > 0 || sending || !user) return
    setSending(true)
    setError('')
    try {
      const code = generateOtp()
      await storeOtp(user.uid, email, code)
      await sendOtp(email, code, profile?.name || email)
      setResendCooldown(300)
      setSent(true)
      setDigits(['', '', '', '', '', ''])
      inputRefs.current[0]?.focus()
    } catch (err) {
      console.error('[otp] send failed:', err)
      setError('Failed to send code: ' + (err?.text || err?.message || JSON.stringify(err)))
    } finally {
      setSending(false)
    }
  }

  // Send OTP once on first mount
  useEffect(() => {
    if (user && !sentOnce.current) {
      sentOnce.current = true
      handleResend()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const handleDigitChange = (index, value) => {
    // Only allow digits
    const v = value.replace(/\D/g, '').slice(-1)
    const next = [...digits]
    next[index] = v
    setDigits(next)
    if (v && index < 5) inputRefs.current[index + 1]?.focus()
  }

  const handleKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }

  const handlePaste = (e) => {
    const text = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6)
    if (text.length === 6) {
      e.preventDefault()
      setDigits(text.split(''))
      inputRefs.current[5]?.focus()
    }
  }

  const handleVerify = async () => {
    const code = digits.join('')
    if (code.length !== 6) { setError('Please enter all 6 digits.'); return }
    setVerifying(true)
    setError('')
    try {
      const result = await verifyOtp(user.uid, code)
      if (result.ok) {
        markSessionVerified()
        setOtpVerified(true)
        const dest = profile ? defaultRouteForRole(profile.role) : '/home'
        navigate(dest, { replace: true })
      } else {
        setError(result.reason)
        setDigits(['', '', '', '', '', ''])
        inputRefs.current[0]?.focus()
        if (result.forceSignOut) {
          setTimeout(() => { logout(); navigate('/login', { replace: true }) }, 1500)
        }
      }
    } catch (err) {
      setError('Verification failed: ' + (err.message || String(err)))
    } finally {
      setVerifying(false)
    }
  }

  // Auto-submit when all 6 digits entered
  useEffect(() => {
    if (digits.every((d) => d) && !verifying) handleVerify()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits])

  const handleSignOut = () => {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="h-full min-h-screen bg-sidebar flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="flex justify-center mb-4">
            <img
              src="/assets/mg-logo.jpg"
              alt="Master Garage"
              className="w-24 h-24 object-cover rounded-full border-2 border-gray-700"
              onError={(e) => { e.currentTarget.style.display = 'none' }}
            />
          </div>
          <div className="text-white font-black text-2xl tracking-wide">
            MG FLEET PORTAL
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-xl p-6 space-y-5">
          <div className="text-center">
            <h1 className="text-xl font-semibold text-gray-800">Verify Your Identity</h1>
            <p className="text-sm text-gray-500 mt-2">
              {sent
                ? <>We sent a 6-digit code to <strong>{maskedEmail}</strong></>
                : 'Sending verification code...'}
            </p>
          </div>

          <div className="flex justify-center gap-2" onPaste={handlePaste}>
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => { inputRefs.current[i] = el }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={d}
                onChange={(e) => handleDigitChange(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                className="w-12 h-14 text-center text-2xl font-black border-2 border-gray-300 rounded-lg focus:border-red-700 focus:outline-none transition-colors"
              />
            ))}
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded px-3 py-2 text-center">
              {error}
            </div>
          )}

          <button
            onClick={handleVerify}
            disabled={verifying || digits.some((d) => !d)}
            className="btn-primary w-full"
          >
            {verifying ? 'Verifying...' : 'Verify'}
          </button>

          <div className="text-center space-y-2">
            <button
              onClick={handleResend}
              disabled={resendCooldown > 0 || sending}
              className="text-sm text-brand hover:underline disabled:text-gray-400 disabled:no-underline"
            >
              {sending ? 'Sending...' : resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
            </button>
            <div>
              <button onClick={handleSignOut} className="text-sm text-gray-500 hover:underline">
                Sign out
              </button>
            </div>
          </div>
        </div>

        <div className="text-center text-gray-500 text-xs mt-4">
          © GM Solutions Inc {new Date().getFullYear()} · v1.0.0
        </div>
      </div>
    </div>
  )
}
