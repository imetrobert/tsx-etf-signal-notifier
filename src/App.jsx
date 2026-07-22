import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { supabase, isConfigured } from './lib/supabase'
import Login from './components/Login'
import Dashboard from './components/Dashboard'
import Watchlist from './components/Watchlist'
import SignalHistory from './components/SignalHistory'

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!isConfigured) {
      setLoading(false)
      return
    }
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => subscription.unsubscribe()
  }, [])

  if (!isConfigured) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1 className="login-title">ETF Signals</h1>
          <p className="login-subtitle">
            Deployment succeeded, but the Supabase secrets (VITE_SUPABASE_URL and
            VITE_SUPABASE_ANON_KEY) are not set yet. Add them in the repo's
            Settings → Secrets and variables → Actions, then re-run the deploy.
          </p>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
      </div>
    )
  }

  return (
    <Router>
      <Routes>
        <Route path="/login" element={!session ? <Login /> : <Navigate to="/" replace />} />
        <Route path="/" element={session ? <Dashboard session={session} /> : <Navigate to="/login" replace />} />
        <Route path="/watchlist" element={session ? <Watchlist session={session} /> : <Navigate to="/login" replace />} />
        <Route path="/signals" element={session ? <SignalHistory session={session} /> : <Navigate to="/login" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  )
}
