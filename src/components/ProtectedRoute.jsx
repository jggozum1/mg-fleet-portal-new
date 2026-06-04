import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { defaultRouteForRole, getRoleInfo, hasPermission } from '../lib/roles'
import { OTP_ENABLED } from '../lib/otp'

export default function ProtectedRoute({ children, allowedCategories, requireAdmin, requiredPermission }) {
  const { user, profile, loading, otpVerified } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (OTP_ENABLED && !otpVerified) {
    return <Navigate to="/otp-verify" replace />
  }

  if (requireAdmin && (!profile || !profile.is_admin)) {
    return <Navigate to={profile ? defaultRouteForRole(profile.role) : '/login'} replace />
  }

  if (allowedCategories && profile && !profile.is_admin) {
    const info = getRoleInfo(profile.role)
    if (!info || !allowedCategories.includes(info.category)) {
      return <Navigate to={defaultRouteForRole(profile.role)} replace />
    }
  }

  // Per-feature permission gating (e.g. requiredPermission="booking")
  if (requiredPermission && profile && !profile.is_admin) {
    if (!hasPermission(profile.role, requiredPermission)) {
      return <Navigate to={defaultRouteForRole(profile.role)} replace />
    }
  }

  return children
}
