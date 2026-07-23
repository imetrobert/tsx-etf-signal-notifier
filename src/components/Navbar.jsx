import { NavLink } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function Navbar({ subtitle, onRefresh, refreshing }) {
  async function handleLogout() {
    await supabase.auth.signOut()
  }

  return (
    <>
      <header className="site">
        <div>
          <div className="brand">imetrobert</div>
          <h1>ETF Signals</h1>
          {subtitle && <div className="sub">{subtitle}</div>}
        </div>
        <div className="header-actions">
          {onRefresh && (
            <button className="refresh" onClick={onRefresh} disabled={refreshing} title="Reload the latest data">
              <span className={refreshing ? 'refresh-icon spinning' : 'refresh-icon'}>↻</span> Refresh
            </button>
          )}
          <button className="signout" onClick={handleLogout}>Sign out</button>
        </div>
      </header>
      <nav className="tabs">
        <NavLink to="/" end className={({ isActive }) => isActive ? 'active' : ''}>Holdings</NavLink>
        <NavLink to="/watchlist" className={({ isActive }) => isActive ? 'active' : ''}>Watchlist</NavLink>
        <NavLink to="/signals" className={({ isActive }) => isActive ? 'active' : ''}>Signals</NavLink>
      </nav>
    </>
  )
}
