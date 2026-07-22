import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function Navbar() {
  const navigate = useNavigate()

  async function handleLogout() {
    await supabase.auth.signOut()
    navigate('/login')
  }

  return (
    <nav className="navbar">
      <Link to="/" className="navbar-brand">
        <img
          src="https://aiwithrobert.com/logo.PNG"
          alt="AI with Robert"
          className="navbar-logo"
          onError={e => { e.target.style.display = 'none' }}
        />
        <div className="navbar-title">
          AI with Robert
          <span>ETF Signals</span>
        </div>
      </Link>

      <div className="navbar-actions">
        <Link
          to="/"
          style={{ color: 'rgba(255,255,255,.8)', fontSize: 13, fontWeight: 600, textDecoration: 'none', padding: '4px 8px' }}
        >
          Holdings
        </Link>
        <Link
          to="/watchlist"
          style={{ color: 'rgba(255,255,255,.8)', fontSize: 13, fontWeight: 600, textDecoration: 'none', padding: '4px 8px' }}
        >
          Watchlist
        </Link>
        <Link
          to="/signals"
          style={{ color: 'rgba(255,255,255,.8)', fontSize: 13, fontWeight: 600, textDecoration: 'none', padding: '4px 8px' }}
        >
          Signals
        </Link>
        <button onClick={handleLogout} className="btn btn-ghost btn-sm" style={{ color: 'rgba(255,255,255,.8)', borderColor: 'rgba(255,255,255,.2)' }}>
          Sign Out
        </button>
      </div>
    </nav>
  )
}
