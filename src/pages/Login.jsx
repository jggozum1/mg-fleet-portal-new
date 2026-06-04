import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { defaultRouteForRole } from '../lib/roles'
import { OTP_ENABLED } from '../lib/otp'

export default function Login() {
  const { user, profile, profileError, loading, login, logout, isFirebaseConfigured, otpVerified } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!loading && user && profile) {
      if (OTP_ENABLED && !otpVerified) {
        navigate('/otp-verify', { replace: true })
      } else {
        const dest = location.state?.from?.pathname || defaultRouteForRole(profile.role)
        navigate(dest, { replace: true })
      }
    }
  }, [loading, user, profile, otpVerified, navigate, location.state])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await login(email, password)
    } catch (err) {
      const msg = err?.code === 'auth/invalid-credential' || err?.code === 'auth/wrong-password'
        ? 'Incorrect email or password.'
        : err?.message || 'Sign in failed.'
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  // Signed in, but no Firestore profile found — surface the debug info.
  const stuck = !loading && user && !profile

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

        {stuck ? (
          <div className="bg-white rounded-lg shadow-xl p-6 space-y-4">
            <h1 className="text-xl font-semibold text-gray-800">Signed in — profile missing</h1>
            <p className="text-sm text-gray-600">
              Firebase authenticated you, but no matching <code>users</code> document was found in Firestore. The
              portal needs one so it knows your role and branch.
            </p>

            <div className="bg-gray-50 border rounded p-3 text-xs font-mono break-all space-y-1">
              <div><span className="text-gray-500">uid:</span> {user.uid}</div>
              <div><span className="text-gray-500">email:</span> {user.email || '(none)'}</div>
            </div>

            {profileError && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded p-2 break-all">
                Lookup failed: {profileError.message}
              </div>
            )}

            <div className="text-xs text-gray-600 space-y-1">
              <div className="font-semibold text-gray-700">We tried to find your profile by:</div>
              <ul className="list-disc list-inside space-y-0.5">
                <li><code>users/{'{uid}'}</code></li>
                <li><code>users</code> where <code>uid == authUid</code></li>
                <li><code>users</code> where <code>email == authEmail</code></li>
                <li><code>users</code> where <code>user_name == authEmail</code></li>
              </ul>
              <div className="pt-2 text-gray-500">
                Check Firestore — what field identifies the user? Paste the doc shape to me and I'll wire it up.
              </div>
            </div>

            <button onClick={logout} className="btn-secondary w-full">
              Sign out
            </button>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="bg-white rounded-lg shadow-xl p-6 space-y-4"
          >
            <h1 className="text-xl font-semibold text-gray-800">Sign in</h1>

            {!isFirebaseConfigured && (
              <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm rounded px-3 py-2">
                <div className="font-semibold mb-1">Firebase not configured</div>
                <div className="text-xs leading-relaxed">
                  Create <code className="bg-yellow-100 px-1 rounded">.env.local</code> from{' '}
                  <code className="bg-yellow-100 px-1 rounded">.env.example</code> and fill the{' '}
                  <code className="bg-yellow-100 px-1 rounded">VITE_FIREBASE_*</code> values from
                  the mg-fms Firebase project. Then restart <code>npm run dev</code>.
                </div>
              </div>
            )}

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded px-3 py-2">
                {error}
              </div>
            )}

            <div>
              <label className="label">Email</label>
              <input
                type="email"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div>
              <label className="label">Password</label>
              <input
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <button
              type="submit"
              disabled={submitting || !isFirebaseConfigured}
              className="btn-primary w-full"
            >
              {submitting ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        )}

        <div className="text-center text-gray-500 text-xs mt-4">
          © GM Solutions Inc {new Date().getFullYear()} · v1.0.0
        </div>
      </div>
    </div>
  )
}
