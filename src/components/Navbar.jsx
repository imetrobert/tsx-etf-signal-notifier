import { NavLink } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function Navbar({ subtitle }) {
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
        <button className="signout" onClick={handleLogout}>Sign out</button>
      </header>
      <nav className="tabs">
        <NavLink to="/" end className={({ isActive }) => isActive ? 'active' : ''}>Holdings</NavLink>
        <NavLink to="/watchlist" className={({ isActive }) => isActive ? 'active' : ''}>Watchlist</NavLink>
        <NavLink to="/signals" className={({ isActive }) => isActive ? 'active' : ''}>Signals</NavLink>
      </nav>
    </>
  )
}
